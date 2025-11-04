require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const twilio = require('twilio'); 
const { VoiceResponse } = twilio.twiml; 

const app = express();
const PORT = 3000; // Local testing port

// Middleware for parsing requests
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); 

// Load environment variables (from .env)
const {
    VAPI_PRIVATE_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID,
    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
    FROM_NUMBER, TO_SPECIALIST_NUMBER
} = process.env;

const VAPI_BASE_URL = 'https://api.vapi.ai/call';
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

let globalCustomerCallSid = ""; 

// --- /inbound_call (Initial AI Connection) ---
app.post('/inbound_call', async (req, res) => {
    globalCustomerCallSid = req.body.CallSid; 
    const callerNumber = req.body.Caller; 
    
    try {
        const vapiResponse = await axios.post(VAPI_BASE_URL, {
            phoneCallProviderBypassEnabled: true,
            phoneNumberId: VAPI_PHONE_NUMBER_ID,
            assistantId: VAPI_ASSISTANT_ID,
            customer: { number: callerNumber },
        }, {
            headers: { 
                'Authorization': `Bearer ${VAPI_PRIVATE_API_KEY}`,
                'Content-Type': 'application/json',
            }
        });

        const returnedTwiml = vapiResponse.data.phoneCallProviderDetails.twiml;
        res.type('text/xml').send(returnedTwiml);

    } catch (error) {
        console.error('Vapi connection failed:', error.message);
        res.status(500).type('text/xml').send('<Response><Say>Connection error.</Say></Response>');
    }
});


// --- /connect (VAPI TOOL WEBHOOK WITH MULTIPLE DEPARTMENTS) ---
app.post('/connect', async (req, res) => {
    try {
        // Extract the department from the request (coming from Vapi)
        const department = (req.body.department || 'consultant').toLowerCase();

        // Define routing directory
        const departmentNumbers = {
            consultant: '+61473016152',
            hr: '+639770880080',
            it: '+639554134947',
        };

        // Default fallback if department not recognized
        const targetNumber = departmentNumbers[department] || departmentNumbers.consultant;

        console.log(`🔁 Transfer requested to: ${department} (${targetNumber})`);

        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const baseUrl = `${protocol}://${req.get('host')}`;
        const conferenceUrl = `${baseUrl}/conference`;
        const statusCallbackUrl = `${baseUrl}/participant-status`;

        // 1. Put the current customer on hold (conference room)
        await twilioClient.calls(globalCustomerCallSid).update({
            url: conferenceUrl,
            method: 'POST',
        });

        // 2. Dial the selected department
        await twilioClient.calls.create({
            to: targetNumber,
            from: FROM_NUMBER,
            url: conferenceUrl,
            method: 'POST',
            statusCallback: statusCallbackUrl,
            statusCallbackMethod: 'POST',
        });

        // ✅ Send confirmation back to Vapi
        return res.json({
            results: [{
                toolCallId: req.body.toolCallList?.[0]?.id || 'transfer_1',
                result: `Transfer initiated to ${department}.`
            }]
        });

    } catch (err) {
        console.error('❌ Transfer failed:', err.message);
        return res.status(500).json({
            results: [{
                toolCallId: req.body.toolCallList?.[0]?.id || 'transfer_error',
                error: 'Transfer failure.'
            }]
        });
    }
});



// --- /conference (TWIML for Merging) ---
app.post('/conference', (req, res) => {
    const twiml = new VoiceResponse();
    twiml.dial().conference(
        {
            startConferenceOnEnter: true, 
            endConferenceOnExit: true,   
        },
        'interactive_cue_room'
    );
    res.type('text/xml').send(twiml.toString());
});


// --- /announce (TWIML for Fallback) ---
app.post('/announce', (req, res) => {
    const twiml = new VoiceResponse();
    twiml.say('I apologize, but our consultants are currently busy. Please call back in a few minutes. Thank you for your understanding, goodbye.');
    twiml.hangup(); 
    res.type('text/xml').send(twiml.toString());
});


// --- /participant-status (The Fallback Logic) ---
app.post('/participant-status', async (req, res) => {
    const callStatus = req.body.CallStatus;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${req.get('host')}`;
    const announceUrl = `${baseUrl}/announce`;

    if (['no-answer', 'busy', 'failed'].includes(callStatus)) {
        try {
            // Redirect customer's call to the announcement TwiML
            await twilioClient.calls(globalCustomerCallSid).update({
                url: announceUrl, 
                method: 'POST',
            });
        } catch (error) {
            console.error("Failed to redirect customer call for announcement:", error.message);
        }
    }
    return res.sendStatus(200); 
});


// Start the server
app.listen(PORT, () => {
    console.log(`\nServer running on port ${PORT}`);
    console.log(`Local URL for ngrok: http://localhost:${PORT}`);
});
