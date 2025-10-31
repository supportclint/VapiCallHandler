require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const twilio = require('twilio'); // Require Twilio only once at the top
const { VoiceResponse } = twilio.twiml;

const app = express();
const PORT = process.env.PORT || 3000; // Use Render's port or 3000 for local

// --- Middleware ---
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// --- Load All Environment Variables ---
const {
    VAPI_PRIVATE_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID,
    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
    FROM_NUMBER, TO_SPECIALIST_NUMBER
} = process.env;

// --- Initialize Twilio Client (only once) ---
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VAPI_BASE_URL = 'https://api.vapi.ai/call';

let globalCustomerCallSid = "";

// =================================================================
// VAPI & CALL TRANSFER LOGIC
// =================================================================

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

// --- /connect (VAPI TOOL WEBHOOK) ---
app.post('/connect', async (req, res) => {
    try {
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const baseUrl = `${protocol}://${req.get('host')}`;
        const conferenceUrl = `${baseUrl}/conference`;
        const statusCallbackUrl = `${baseUrl}/participant-status`;

        await twilioClient.calls(globalCustomerCallSid).update({
            url: conferenceUrl,
            method: 'POST',
        });

        await twilioClient.calls.create({
            to: TO_SPECIALIST_NUMBER,
            from: FROM_NUMBER,
            url: conferenceUrl,
            method: 'POST',
            statusCallback: statusCallbackUrl,
            statusCallbackMethod: 'POST',
        });

        return res.json({
            results: [{
                toolCallId: req.body.toolCallList[0].id,
                result: "Transfer initiated."
            }]
        });

    } catch (err) {
        console.error('Transfer failed:', err.message);
        return res.status(500).json({
            results: [{
                toolCallId: req.body.toolCallList[0].id,
                error: "Transfer failure."
            }]
        });
    }
});

// --- /conference (TWIML for Merging) ---
app.post('/conference', (req, res) => {
    const twiml = new VoiceResponse();
    twiml.dial().conference({
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
    }, 'interactive_cue_room');
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

// =================================================================
// DASHBOARD API ENDPOINT
// =================================================================

app.get('/api/calls', async (req, res) => {
    console.log('Received request for /api/calls');

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        console.error('Twilio credentials are not set in environment variables.');
        return res.status(500).json({ error: 'Server configuration error: Missing Twilio credentials.' });
    }

    try {
        const calls = await twilioClient.calls.list({ limit: 100 });
        console.log(`Successfully fetched ${calls.length} calls from Twilio.`);

        const formattedCalls = calls.map(call => ({
            sid: call.sid,
            status: call.status,
            to: call.toFormatted,
            from: call.fromFormatted,
            startTime: call.startTime,
            endTime: call.endTime,
            duration: call.duration,
            price: call.price,
            priceUnit: call.priceUnit,
            summary: `Call from ${call.fromFormatted} to ${call.toFormatted}`,
            transcript: 'Transcript data is not available directly from the Twilio Call Log API.',
        }));

        res.json(formattedCalls);

    } catch (error) {
        console.error('Failed to fetch call logs from Twilio:', error);
        res.status(500).json({ error: 'Could not retrieve call data from Twilio.' });
    }
});

// =================================================================
// START THE SERVER (This should always be last)
// =================================================================

app.listen(PORT, () => {
    console.log(`\nServer running on port ${PORT}`);
});
