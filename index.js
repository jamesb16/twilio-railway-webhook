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

    const email =
      body.email ||
      body.Email ||
      body.contact?.email ||
      body.contact?.emailAddress ||
      "";

    const address =
      body.address ||
      body.Address ||
      body.contact?.address1 ||
      body.contact?.address ||
      "";

    const postcode =
      body.postcode ||
      body.postCode ||
      body.Postcode ||
      body.contact?.postalCode ||
      body.contact?.postcode ||
      "";

    const propertyType =
      body.propertyType ||
      body["Property Type"] ||
      body.contact?.propertyType ||
      "";

    const isHomeowner =
      body.isHomeowner ||
      body["Are You The Homeowner"] ||
      body.contact?.isHomeowner ||
      "";

    if (!phoneRaw) {
      return res.status(400).json({ ok: false, error: "Missing phone in webhook payload" });
    }

    const to = String(phoneRaw).trim();
    const from = process.env.TWILIO_FROM_NUMBER;

    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !from) {
      return res.status(500).json({
        ok: false,
        error: "Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER env vars"
      });
    }

    const baseUrl = process.env.PUBLIC_BASE_URL;
    if (!baseUrl) {
      return res.status(500).json({
        ok: false,
        error: "Missing PUBLIC_BASE_URL env var (your Railway public URL)"
      });
    }

    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
      to,
      from,
      // Twilio will request TwiML from here when the call connects
      url: `${baseUrl}/twilio/voice?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(
        to
      )}&email=${encodeURIComponent(email)}&address=${encodeURIComponent(
        address
      )}&postcode=${encodeURIComponent(postcode)}&propertyType=${encodeURIComponent(
        propertyType
      )}&isHomeowner=${encodeURIComponent(isHomeowner)}`,
      method: "POST",

      statusCallback: `${baseUrl}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

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
app.post("/twilio/voice", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const name = (req.query.name || "there").toString();
  const phone = (req.query.phone || "").toString();
  const email = (req.query.email || "").toString();
  const address = (req.query.address || "").toString();
  const postcode = (req.query.postcode || "").toString();
  const propertyType = (req.query.propertyType || "").toString();
  const isHomeowner = (req.query.isHomeowner || "").toString(); // Get homeowner info from form

  const callSid = req.body.CallSid || req.query.CallSid || "";

  // Create / reset session
  sessions.set(callSid, {
    lead: { name, phone, email, address, postcode, propertyType, isHomeowner },
    transcript: [{ role: "assistant", text: "Call started." }],
    turns: 0
  });

  let twiml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Say voice="alice" loop="false">Hi ${escapeXml(name)}. It’s Greenbug Energy. You requested a callback about a site survey.</Say>`;

  // Skip asking homeowner question if already answered in the form
  if (isHomeowner === "Yes") {
    twiml += `<Say voice="alice" loop="false">Thank you for confirming. We will proceed with your survey booking.</Say>`;
    twiml += `<Gather input="speech" action="/twilio/speech" method="POST" speechTimeout="auto" timeout="2" maxSpeechTime="3"/>`; // Timeout reduced
  } else {
    twiml += `<Say voice="alice" loop="false">Can you confirm if you are the homeowner?</Say>`;
    twiml += `<Gather input="speech" action="/twilio/speech" method="POST" speechTimeout="auto" timeout="2" maxSpeechTime="3"/>`; // Timeout reduced
  }

  twiml += `<Say voice="alice" loop="false">Sorry, I didn't catch that. We’ll send you a text to rebook. Goodbye.</Say>
  </Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Capture speech result ----------
app.post("/twilio/speech", (req, res) => {
  const speech = (req.body.SpeechResult || "").toLowerCase();
  const confidence = req.body.Confidence;

  console.log("SpeechResult:", { speech, confidence });

  let reply = "Sorry, I didn't catch that. Can you say that again?";
  if (speech.includes("yes")) {
    reply = "Thank you! We will proceed with the survey.";
  } else if (speech.includes("no")) {
    reply = "Alright, please let us know when you're ready for the survey.";
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" loop="false">${escapeXml(reply)}</Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Capture call status callback ----------
app.post("/twilio/status", (req, res) => {
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration,
    Timestamp: req.body.Timestamp
  };

  console.log("Call status:", payload);

  // Cleanup finished calls
  if (payload.CallStatus === "completed") {
    sessions.delete(payload.CallSid);
  }

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
