const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

/**
 * sessions[CallSid] = {
 *   lead: { name, phone, email, address, postcode, propertyType, isHomeowner },
 *   transcript: [{ role: "assistant"|"user", text }],
 *   turns: number,
 *   stage: "OPEN"|"CONFIRM_ADDRESS"|"ASK_DAY"|"ASK_WINDOW"|"CONFIRM_CLOSE"|"DONE",
 *   retries: { confirmAddress: number, askDay: number, askWindow: number },
 *   booking: { preferred_day, preferred_window, confirmed_address, notes }
 * }
 */
const sessions = new Map();

// Use fetch safely on Railway (Node 18+ has global fetch; fallback just in case)
const fetchFn =
  global.fetch ||
  ((...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args)));

// -------------------- Helpers: speech normalization --------------------
function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function isYes(s) {
  const t = norm(s);
  return (
    t === "yes" ||
    t === "yeah" ||
    t === "yeh" ||
    t === "yep" ||
    t === "aye" ||
    t === "yup" ||
    t.includes("yes") ||
    t.includes("yeah") ||
    t.includes("yeh") ||
    t.includes("aye") ||
    t.includes("correct") ||
    t.includes("that’s right") ||
    t.includes("thats right") ||
    t.includes("right")
  );
}

function isNo(s) {
  const t = norm(s);
  return (
    t === "no" ||
    t === "nope" ||
    t === "nah" ||
    t.includes("no") ||
    t.includes("not") ||
    t.includes("wrong") ||
    t.includes("incorrect")
  );
}

function extractWindow(s) {
  const t = norm(s);
  if (t.includes("morning") || t.includes("am") || t.includes("a.m")) return "Morning";
  if (t.includes("afternoon") || t.includes("pm") || t.includes("p.m")) return "Afternoon";
  if (t.includes("evening")) return "Evening"; // optional
  return "";
}

function extractDay(s) {
  const t = norm(s);
  const days = [
    "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
    "mon","tue","tues","wed","thu","thur","thurs","fri","sat","sun"
  ];
  for (const d of days) {
    if (t.includes(d)) {
      // Normalise short forms
      if (d.startsWith("mon")) return "Monday";
      if (d.startsWith("tue")) return "Tuesday";
      if (d.startsWith("wed")) return "Wednesday";
      if (d.startsWith("thu")) return "Thursday";
      if (d.startsWith("fri")) return "Friday";
      if (d.startsWith("sat")) return "Saturday";
      if (d.startsWith("sun")) return "Sunday";
    }
  }
  // “tomorrow” / “next week” etc (basic)
  if (t.includes("tomorrow")) return "Tomorrow";
  if (t.includes("next week")) return "Next week";
  return "";
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function ttsUrl(baseUrl, text) {
  return `${baseUrl}/tts?text=${encodeURIComponent(text)}`;
}

function ensureSession(callSid) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      lead: {},
      transcript: [],
      turns: 0,
      stage: "OPEN",
      retries: { confirmAddress: 0, askDay: 0, askWindow: 0 },
      booking: { preferred_day: "", preferred_window: "", confirmed_address: "", notes: "" }
    });
  }
  return sessions.get(callSid);
}

// -------------------- Health --------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug outbound AI is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// -------------------- Trigger outbound call from GHL --------------------
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    const phoneRaw = body.phone || body.Phone || body.contact?.phone || body.contact?.phoneNumber || body.contact?.phone_number;
    const name = body.name || body.full_name || body.fullName || body.contact?.name || [body.contact?.firstName, body.contact?.lastName].filter(Boolean).join(" ") || body.contact?.first_name || "there";
    const email = body.email || body.Email || body.contact?.email || body.contact?.emailAddress || "";
    const address = body.address || body.Address || body.contact?.address1 || body.contact?.address || "";
    const postcode = body.postcode || body.postCode || body.Postcode || body.contact?.postalCode || body.contact?.postcode || "";
    const propertyType = body.propertyType || body["Property Type"] || body.contact?.propertyType || "";
    const isHomeowner = body.isHomeowner || body["Are You The Homeowner"] || body.contact?.isHomeowner || "";

    const preferred_day = body.booking?.preferred_day; // We are now tracking the preferred day

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
      url: `${baseUrl}/twilio/voice?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(to)}&email=${encodeURIComponent(email)}&address=${encodeURIComponent(address)}&postcode=${encodeURIComponent(postcode)}&propertyType=${encodeURIComponent(propertyType)}&isHomeowner=${encodeURIComponent(isHomeowner)}&preferred_day=${encodeURIComponent(preferred_day)}`,
      method: "POST",
      statusCallback: `${baseUrl}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    return res.status(200).json({ ok: true, message: "Call triggered", sid: call.sid, to, name });
  } catch (err) {
    console.error("Error in /ghl/lead:", err);
    return res.status(500).json({ ok: false, error: err.message || "Unknown error" });
  }
});

// -------------------- Twilio: first prompt (TwiML) --------------------
app.post("/twilio/voice", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;

  const name = (req.query.name || "there").toString();
  const phone = (req.query.phone || "").toString();
  const email = (req.query.email || "").toString();
  const address = (req.query.address || "").toString();
  const postcode = (req.query.postcode || "").toString();
  const propertyType = (req.query.propertyType || "").toString();
  const isHomeowner = (req.query.isHomeowner || "").toString();

  const callSid = req.body.CallSid || req.query.CallSid || "";

  const session = ensureSession(callSid);
  session.lead = { name, phone, email, address, postcode, propertyType, isHomeowner };
  session.transcript = [{ role: "assistant", text: "Call started." }];
  session.turns = 0;
  session.stage = "OPEN";
  session.retries = { confirmAddress: 0, askDay: 0, askWindow: 0 };
  session.booking = { preferred_day: "", preferred_window: "", confirmed_address: "", notes: "" };

  sessions.set(callSid, session);

  const opening = `Hi ${name}. It’s Nicola from Greenbug Energy. You requested a free home energy survey about solar panels — have I caught you at an okay time?`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, opening)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="6"/>
  <Play>${ttsUrl(baseUrl, "No worries — I’ll send you a text and you can pick a time that suits. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// -------------------- Twilio: speech capture --------------------
app.post("/twilio/speech", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence;

  const session = ensureSession(callSid);
  session.turns = (session.turns || 0) + 1;

  if (speech) session.transcript.push({ role: "user", text: speech });

  console.log("Speech:", { callSid, speech, confidence, stage: session.stage });

  if (session.turns >= 14) {
    session.stage = "DONE";
    sessions.set(callSid, session);
    const bye = "Thanks for that — I’ll send you a quick text and we can take it from there. Bye for now.";
    const twimlEnd = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, bye)}</Play>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twimlEnd);
  }

  // Stage logic...
  // Implement your stage transitions as per the workflow

  res.status(200).send('OK');
});

// -------------------- Call status callback --------------------
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

  if (payload.CallStatus === "completed") {
    sessions.delete(payload.CallSid);
  }

  res.status(200).send("ok");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
