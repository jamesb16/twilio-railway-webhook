const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL often sends JSON; Twilio sends x-www-form-urlencoded
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// -------------------- Config --------------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  PUBLIC_BASE_URL,
  CALL_DELAY_SECONDS,
  TWILIO_TTS_VOICE,
  RESULT_WEBHOOK_URL
} = process.env;

const DEFAULT_VOICE = TWILIO_TTS_VOICE || "Polly.Emma"; // More natural than "alice"
const DELAY_SECONDS = parseInt(CALL_DELAY_SECONDS || "0", 10);

// -------------------- Helpers --------------------
function escapeXml(unsafe = "") {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(res) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !PUBLIC_BASE_URL) {
    res.status(500).json({
      ok: false,
      error:
        "Missing env vars. Need: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, PUBLIC_BASE_URL"
    });
    return false;
  }
  return true;
}

async function postResult(payload) {
  if (!RESULT_WEBHOOK_URL) return;

  try {
    // Node 18+ has fetch built-in on Railway
    await fetch(RESULT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("RESULT_WEBHOOK_URL post failed:", e?.message || e);
  }
}

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug Energy outbound server running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// -------------------- GHL → trigger outbound call --------------------
// Point your GHL webhook here:  POST https://YOUR_DOMAIN/ghl/lead
app.post("/ghl/lead", async (req, res) => {
  try {
    if (!requireEnv(res)) return;

    const body = req.body || {};

    // Try common GHL payload paths
    const phoneRaw =
      body.phone ||
      body.Phone ||
      body.contact?.phone ||
      body.contact?.phoneNumber ||
      body.contact?.phone_number;

    const name =
      body.name ||
      body.full_name ||
      body.fullName ||
      body.contact?.name ||
      body.contact?.firstName ||
      body.contact?.first_name ||
      "there";

    if (!phoneRaw) {
      return res.status(400).json({ ok: false, error: "Missing phone in webhook payload" });
    }

    const to = String(phoneRaw).trim(); // should already be E.164 (+44...)
    const from = TWILIO_FROM_NUMBER;

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    // Respond immediately so GHL doesn’t time out
    res.status(200).json({
      ok: true,
      message: `Lead received. Calling in ${DELAY_SECONDS || 0}s.`,
      to,
      name
    });

    // Optional delay (e.g. 120 seconds)
    if (DELAY_SECONDS > 0) await sleep(DELAY_SECONDS * 1000);

    const call = await client.calls.create({
      to,
      from,

      // When the call connects, Twilio fetches TwiML from here:
      url: `${PUBLIC_BASE_URL}/twilio/voice?name=${encodeURIComponent(name)}`,
      method: "POST",

      // Track call status:
      statusCallback: `${PUBLIC_BASE_URL}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    console.log("Outbound call created:", { sid: call.sid, to, name });

    await postResult({
      type: "call_created",
      callSid: call.sid,
      to,
      name,
      ts: new Date().toISOString()
    });
  } catch (err) {
    console.error("Error in /ghl/lead:", err);
    // If we already responded to GHL, just log.
  }
});

// -------------------- TwiML: what the call says --------------------
app.post("/twilio/voice", (req, res) => {
  const name = (req.query.name || "there").toString();

  // IMPORTANT: Use absolute URL for Gather action
  const gatherAction = `${PUBLIC_BASE_URL}/twilio/speech`;

  // “Better voice” = Amazon Polly voices (more human than default Twilio voices)
  // Examples you can set in TWILIO_TTS_VOICE:
  // Polly.Emma (UK), Polly.Brian (UK), Polly.Amy (UK), Polly.Joanna (US)
  const voice = DEFAULT_VOICE;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(voice)}">Hi ${escapeXml(name)}, it's Greenbug Energy.</Say>
  <Say voice="${escapeXml(voice)}">You just requested a callback about a site survey. Have I caught you at an okay time?</Say>

  <Gather input="speech" action="${escapeXml(gatherAction)}" method="POST" speechTimeout="auto">
    <Say voice="${escapeXml(voice)}">You can say: yes, book a survey. Or say: call me later.</Say>
  </Gather>

  <Say voice="${escapeXml(voice)}">No worries. We'll send a text so you can pick a better time. Goodbye.</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// -------------------- Capture speech result --------------------
app.post("/twilio/speech", async (req, res) => {
  const speechRaw = (req.body.SpeechResult || "").toString();
  const speech = speechRaw.toLowerCase();
  const confidence = req.body.Confidence;
  const callSid = req.body.CallSid;

  console.log("SpeechResult:", { callSid, speech: speechRaw, confidence });

  // Basic intent classification (simple for now)
  let intent = "unknown";
  if (speech.includes("later") || speech.includes("not now") || speech.includes("busy")) intent = "call_later";
  if (speech.includes("yes") || speech.includes("book") || speech.includes("survey")) intent = "book_survey";

  // What we say back:
  let reply =
    "Thanks. We'll be in touch shortly. Goodbye.";
  if (intent === "call_later") reply = "No problem at all. We'll call you later. Goodbye.";
  if (intent === "book_survey")
    reply =
      "Perfect. We'll get your site survey booked in and text you the details. Goodbye.";

  await postResult({
    type: "speech",
    callSid,
    intent,
    speech: speechRaw,
    confidence,
    ts: new Date().toISOString()
  });

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(DEFAULT_VOICE)}">${escapeXml(reply)}</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// -------------------- Call status callback --------------------
app.post("/twilio/status", async (req, res) => {
  const payload = {
    type: "call_status",
    callSid: req.body.CallSid,
    callStatus: req.body.CallStatus, // initiated/ringing/answered/completed
    to: req.body.To,
    from: req.body.From,
    duration: req.body.CallDuration,
    timestamp: req.body.Timestamp,
    ts: new Date().toISOString()
  };

  console.log("Call status callback:", payload);

  await postResult(payload);

  res.status(200).send("ok");
});

// -------------------- Listen --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
