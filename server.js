require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const twilio = require('twilio'); 
const { VoiceResponse } = twilio.twiml; 

const app = express();
const PORT = 3000;

// Middleware for parsing requests
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); 

// Load environment variables
const {
    VAPI_PRIVATE_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID,
    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
    FROM_NUMBER, TO_SPECIALIST_NUMBER
} = process.env;

const VAPI_BASE_URL = 'https://api.vapi.ai/call';

// Initialize Twilio Client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Global variable to store the customer's active Twilio Call SID 
let globalCustomerCallSid = ""; 

// =========================================================================
// 1. INBOUND CALL ENTRY POINT: /inbound_call
// =========================================================================
app.post('/inbound_call', async (req, res) => {
    console.log('\n--- Incoming Twilio Call Webhook ---');
    
    // CRITICAL: Save the Twilio Call SID for later transfer updates
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
        console.log(`Call SID ${globalCustomerCallSid} connected to Vapi. Returning TwiML...`);
        res.type('text/xml').send(returnedTwiml);

    } catch (error) {
        console.error('Error connecting to Vapi:', error.message);
        res.status(500).type('text/xml').send('<Response><Say>Connection error.</Say></Response>');
    }
});


// =========================================================================
// 2. VAPI TOOL WEBHOOK: /connect
// =========================================================================
// This is hit when the AI calls the 'transfer_to_specialist' tool.
app.post('/connect', async (req, res) => {
    console.log('\n--- VAPI TOOL: /connect triggered ---');
    
    try {
        // Construct the base URL for Twilio callbacks (using the current ngrok address)
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const baseUrl = `${protocol}://${req.get('host')}`;
        const conferenceUrl = `${baseUrl}/conference`;
        const statusCallbackUrl = `${baseUrl}/participant-status`;

        // 1. Update the Customer's Inbound Call (Puts customer on hold)
        await twilioClient.calls(globalCustomerCallSid).update({
            url: conferenceUrl,
            method: 'POST',
        });
        console.log(`Customer call ${globalCustomerCallSid} updated to join conference.`);

        // 2. Dial the Specialist (Outbound Call)
        await twilioClient.calls.create({
            to: TO_SPECIALIST_NUMBER,
            from: FROM_NUMBER,
            url: conferenceUrl, // Specialist also joins the same conference
            method: 'POST',
            statusCallback: statusCallbackUrl, // Webhook for no-answer/busy logic
            statusCallbackMethod: 'POST',
        });
        console.log(`Dialing specialist at ${TO_SPECIALIST_NUMBER}...`);

        // Respond to Vapi (the Tool Call)
        return res.json({ 
            results: [{ 
                toolCallId: req.body.toolCallId,
                result: "Transfer initiated successfully." 
            }]
        });

    } catch (err) {
        console.error('Error initiating call transfer:', err.message);
        return res.status(500).json({ 
            results: [{ 
                toolCallId: req.body.toolCallId,
                error: "Failed to initiate Twilio conference." 
            }]
        });
    }
});


// =========================================================================
// 3. TWIML ENDPOINT: /conference
// =========================================================================
// Both the customer and the specialist are routed here to join the conference room.
app.post('/conference', (req, res) => {
    const twiml = new VoiceResponse();
    
    console.log('\n--- Twilio /conference TwiML request ---');

    // Put the call into a conference room named 'interactive_cue_room'
    twiml.dial().conference(
        {
            startConferenceOnEnter: true, 
            endConferenceOnExit: true,   
        },
        'interactive_cue_room'
    );

    res.type('text/xml').send(twiml.toString());
});


// =========================================================================
// 4. TWIML ENDPOINT: /announce
// =========================================================================
// This TwiML is called to play an announcement and hang up the customer.
app.post('/announce', (req, res) => {
    const twiml = new VoiceResponse();
    
    console.log('\n--- Twilio /announce TwiML request ---');

    // 1. Play the announcement
    twiml.say('I apologize, but all consultants are currently busy. Please call back in a few minutes. Goodbye.');
    
    // 2. Hang up the customer call
    twiml.hangup(); 

    res.type('text/xml').send(twiml.toString());
});


// =========================================================================
// 5. STATUS WEBHOOK: /participant-status (The Fallback Logic)
// =========================================================================
app.post('/participant-status', async (req, res) => {
    const callStatus = req.body.CallStatus;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${req.get('host')}`;
    const announceUrl = `${baseUrl}/announce`;

    console.log(`\n--- Specialist Call Status Update: ${callStatus} ---`);

    // If the specialist's leg fails (busy, no-answer, or failed to connect)
    if (['no-answer', 'busy', 'failed'].includes(callStatus)) {
        console.log("Specialist did not answer. Initiating customer announcement.");
        
        try {
            // Update the original customer's call (globalCustomerCallSid)
            // Redirect customer's line to the announcement TwiML
            await twilioClient.calls(globalCustomerCallSid).update({
                url: announceUrl, 
                method: 'POST',
            });
            console.log("Customer call successfully redirected to announcement.");
        } catch (error) {
            console.error("Failed to redirect customer call for announcement:", error.message);
        }
    }
    
    // Always respond 200 OK to acknowledge the webhook
    return res.sendStatus(200); 
});


// Start the server
app.listen(PORT, () => {
    console.log(`\nServer running on port ${PORT}`);
    console.log(`Local URL for ngrok: http://localhost:${PORT}`);
});