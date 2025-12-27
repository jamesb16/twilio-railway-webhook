const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL usually sends JSON. Twilio sends x-www-form-urlencoded.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// --- ENV VARS (set these on Railway) ---
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  BASE_URL, // e.g. https://twilio-railway-webhook-production.up.railway.app
} = process.env;

const client =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// Root + health
app.get("/", (req, res) => res.status(200).send("OK - Railway Node server is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

/**
 * Twilio Voice webhook (TwiML)
 * This is what Twilio requests when the call connects.
 * For now it's a simple script. Next step we replace with full conversational AI.
 */
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml");

  // You can pass lead info on the URL querystring when creating the call
  const leadName = (req.query.name || "").toString();
  const friendlyName = leadName ? ` ${leadName}` : "";

  // NOTE: Twilio built-in voices are limited; we'll improve voice next step.
  // Keep it simple for now.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello${friendlyName}. It's Michael's team. You just requested a quote. Is now a good time for a quick call?</Say>
  <Pause length="1"/>
  <Say>If not, no worries. We can text you a link to book a survey.</Say>
</Response>`;

  res.send(twiml);
});

/**
 * GHL -> Railway webhook
 * GHL should POST lead details here AFTER a 2 minute wait step in the workflow.
 */
app.post("/ghl/lead", async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ ok: false, error: "Twilio client not configured. Check env vars." });
    }
    if (!BASE_URL) {
      return res.status(500).json({ ok: false, error: "Missing BASE_URL env var." });
    }
    if (!TWILIO_FROM_NUMBER) {
      return res.status(500).json({ ok: false, error: "Missing TWILIO_FROM_NUMBER env var." });
    }

    // ---- Pull lead fields from GHL payload (we’ll map properly once you show your exact webhook body) ----
    // Try common keys; you can adjust to match your GHL webhook fields.
    const to =
      req.body.phone ||
      req.body.phoneNumber ||
      req.body.contact_phone ||
      req.body.contact?.phone ||
      req.body?.data?.phone ||
      "";

    const name =
      req.body.fullName ||
      req.body.name ||
      req.body.contact_name ||
      req.body.contact?.name ||
      req.body?.data?.name ||
      "";

    if (!to) {
      return res.status(400).json({ ok: false, error: "No phone number found in webhook body." });
    }

    // Build the TwiML URL Twilio will fetch when the call is answered
    const voiceUrl = `${BASE_URL}/twilio/voice?name=${encodeURIComponent(name)}`;

    // Optional: status callback so we can capture outcome
    const statusCallbackUrl = `${BASE_URL}/twilio/status`;

    const call = await client.calls.create({
      to,
      from: TWILIO_FROM_NUMBER,
      url: voiceUrl,
      method: "POST",
      statusCallback: statusCallbackUrl,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    return res.status(200).json({
      ok: true,
      message: "Call initiated",
      sid: call.sid,
      to,
      name,
    });
  } catch (err) {
    console.error("GHL lead webhook error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

/**
 * Twilio status callback (capture call result)
 * Twilio posts CallStatus + CallDuration etc.
 * Later we’ll push this back into GHL or your CRM.
 */
app.post("/twilio/status", (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus; // completed, busy, no-answer, failed, etc.
  const to = req.body.To;
  const from = req.body.From;
  const duration = req.body.CallDuration;

  console.log("TWILIO STATUS:", { callSid, callStatus, to, from, duration });

  res.status(200).send("OK");
});

// IMPORTANT: Railway PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
