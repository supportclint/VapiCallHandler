require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const { VoiceResponse } = twilio.twiml;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Load environment variables
const {
  VAPI_PRIVATE_API_KEY, VAPI_ASSISTANT_ID, VAPI_PHONE_NUMBER_ID,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  FROM_NUMBER, CONSULTANT_NUMBER, HR_NUMBER, IT_NUMBER
} = process.env;

const VAPI_BASE_URL = 'https://api.vapi.ai/call';
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

let globalCustomerCallSid = "";

// --- /inbound_call (initial AI greeting & assistant connect) ---
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
    console.error('❌ Vapi connection failed:', error.message);
    res.status(500).type('text/xml').send('<Response><Say>Connection error. Please try again later.</Say></Response>');
  }
});

// --- /connect (VAPI TOOL WEBHOOK) ---
app.post('/connect', async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${req.get('host')}`;
    const conferenceUrl = `${baseUrl}/conference`;
    const statusCallbackUrl = `${baseUrl}/participant-status`;

    // 🔍 Identify department from Vapi tool input
    const department = req.body.toolCallList?.[0]?.input?.department?.toLowerCase();
    let targetNumber;

    switch (department) {
      case 'consultant':
      case 'sales':
      case 'strategy':
        targetNumber = CONSULTANT_NUMBER;
        break;
      case 'hr':
      case 'hr department':
      case 'human resources':
      case 'job':
        targetNumber = HR_NUMBER;
        break;
      case 'it':
      case 'it department':
      case 'technical':
      case 'support':
        targetNumber = IT_NUMBER;
        break;
      default:
        throw new Error('Invalid or missing department input.');
    }

    console.log(`🔁 Transfer requested to: ${department} (${targetNumber})`);

    // 1️⃣ Put customer on hold (conference bridge)
    await twilioClient.calls(globalCustomerCallSid).update({
      url: conferenceUrl,
      method: 'POST',
    });

    // 2️⃣ Dial the correct department
    await twilioClient.calls.create({
      to: targetNumber,
      from: FROM_NUMBER,
      url: conferenceUrl,
      method: 'POST',
      statusCallback: statusCallbackUrl,
      statusCallbackMethod: 'POST',
    });

    // ✅ Respond success to Vapi
    return res.json({
      results: [{
        toolCallId: req.body.toolCallList[0].id,
        result: `Transfer to ${department} initiated.`,
      }]
    });

  } catch (err) {
    console.error('❌ Transfer failed:', err.message);
    return res.status(500).json({
      results: [{
        toolCallId: req.body.toolCallList?.[0]?.id || 'unknown',
        error: "Transfer failure.",
      }]
    });
  }
});

// --- /conference (merging customer + department call) ---
app.post('/conference', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.dial().conference({
    startConferenceOnEnter: true,
    endConferenceOnExit: true,
  }, 'interactive_cue_room');
  res.type('text/xml').send(twiml.toString());
});

// --- /announce (fallback message) ---
app.post('/announce', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say('Our specialists are currently unavailable. Please call back later. Thank you for your patience.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// --- /participant-status (handles no answer or failed transfer) ---
app.post('/participant-status', async (req, res) => {
  const callStatus = req.body.CallStatus;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const baseUrl = `${protocol}://${req.get('host')}`;
  const announceUrl = `${baseUrl}/announce`;

  if (['no-answer', 'busy', 'failed'].includes(callStatus)) {
    try {
      console.log(`⚠️ Transfer failed (${callStatus}) — redirecting customer to fallback message.`);
      await twilioClient.calls(globalCustomerCallSid).update({
        url: announceUrl,
        method: 'POST',
      });
    } catch (error) {
      console.error("❌ Fallback redirect failed:", error.message);
    }
  }

  return res.sendStatus(200);
});

// --- Start the server ---
app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`🌐 Local URL (for ngrok or Render): http://localhost:${PORT}`);
});
