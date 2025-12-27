const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("OK - Railway Node server is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ---------- Outbound call trigger from GHL ----------
app.post("/ghl/lead", async (req, res) => {
  try {
    // GHL payloads can vary. We try multiple common paths.
    const body = req.body || {};
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

    // IMPORTANT: Twilio needs E.164 format e.g. +447...
    const to = String(phoneRaw).trim();
    const from = process.env.TWILIO_FROM_NUMBER;

    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !from) {
      return res.status(500).json({
        ok: false,
        error: "Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER env vars"
      });
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const baseUrl = process.env.PUBLIC_BASE_URL; // set this in Railway
    // Example: https://twilio-railway-webhook-production.up.railway.app
    if (!baseUrl) {
      return res.status(500).json({
        ok: false,
        error: "Missing PUBLIC_BASE_URL env var (your Railway public URL)"
      });
    }

    const call = await client.calls.create({
      to,
      from,
      // Twilio will request TwiML from here when the call connects
      url: `${baseUrl}/twilio/voice?name=${encodeURIComponent(name)}`,
      method: "POST",

      // Capture outcome of the call
      statusCallback: `${baseUrl}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    // Respond immediately so GHL doesn’t timeout
    return res.status(200).json({
      ok: true,
      message: "Call triggered",
      sid: call.sid,
      to,
      name
    });
  } catch (err) {
    console.error("Error in /ghl/lead:", err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// ---------- What the call says (TwiML) ----------
app.post("/twilio/voice", (req, res) => {
  const name = (req.query.name || "there").toString();

  // Simple “script” for now. We’ll upgrade this to a real conversational AI next.
  // (Also: Polly/ElevenLabs etc comes later. One step at a time.)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hi ${escapeXml(name)}. It's Greenbug. You just requested a callback about a site survey.</Say>
  <Say voice="alice">If now is a good time, please say: book a survey. Otherwise say: call me later.</Say>

  <Gather input="speech" action="/twilio/speech" method="POST" speechTimeout="auto" />
  <Say voice="alice">Sorry, I didn't catch that. We'll send you a text to rebook. Goodbye.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Capture speech result ----------
app.post("/twilio/speech", (req, res) => {
  const speech = (req.body.SpeechResult || "").toLowerCase();
  const confidence = req.body.Confidence;

  console.log("SpeechResult:", { speech, confidence });

  // Minimal “result capture” for now:
  // - if they say “later” -> log it
  // - if “book” -> log it
  // Later we’ll actually book in calendar + send SMS.
  let reply = "Thanks. We'll be in touch shortly. Goodbye.";
  if (speech.includes("later")) reply = "No problem. We'll call you later. Goodbye.";
  if (speech.includes("book")) reply = "Perfect. We'll book your survey and text you the details. Goodbye.";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(reply)}</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Capture call status (result) ----------
app.post("/twilio/status", (req, res) => {
  // Twilio sends lots of fields; these are the key ones
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration,
    Timestamp: req.body.Timestamp
  };

  console.log("Call status callback:", payload);
  res.status(200).send("ok");
});

// ---------- Helpers ----------
function escapeXml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// IMPORTANT: listen on Railway port
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
