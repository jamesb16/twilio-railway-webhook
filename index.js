const express = require("express");
const twilio = require("twilio");

const app = express();

// GHL often sends JSON; Twilio webhooks are x-www-form-urlencoded
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// In-memory session storage
const sessions = new Map();

const fetchFn = global.fetch || ((...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args)));

// Helper function to normalize speech input
function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function extractWindow(s) {
  const t = norm(s);
  if (t.includes("morning") || t.includes("am") || t.includes("a.m")) return "Morning";
  if (t.includes("afternoon") || t.includes("pm") || t.includes("p.m")) return "Afternoon";
  return "";
}

function extractDay(s) {
  const t = norm(s);
  if (t.includes("monday")) return "Monday";
  if (t.includes("tuesday")) return "Tuesday";
  if (t.includes("wednesday")) return "Wednesday";
  if (t.includes("thursday")) return "Thursday";
  if (t.includes("friday")) return "Friday";
  return "";
}

// Ensure session exists
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

// Health check routes
app.get("/", (req, res) => res.status(200).send("OK - Greenbug outbound AI is running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Trigger outbound call from GHL
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    const phoneRaw = body.phone || body.Phone || body.contact?.phone;
    const name = body.name || body.full_name || body.contact?.name || "there";
    const email = body.email || body.Email || body.contact?.email || "";
    const address = body.address || body.Address || body.contact?.address1 || "";
    const postcode = body.postcode || body.contact?.postalCode || "";
    const propertyType = body.propertyType || body.contact?.propertyType || "";
    const isHomeowner = body.isHomeowner || body.contact?.isHomeowner || "";

    const preferred_day = body.booking?.preferred_day; // Capturing preferred day for calendar booking

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

// -------------------- Calendar booking (add this) --------------------
async function postToCalendarBooking({ lead, booking }) {
  const url = process.env.GHL_BOOKING_TRIGGER_URL;
  if (!url) throw new Error("Missing GHL_BOOKING_TRIGGER_URL env var");

  const payload = {
    agent: "Nicola",
    source: "AI_CALL",
    intent: "BOOK",
    phone: lead?.phone || "",
    name: lead?.name || "",
    email: lead?.email || "",
    address: lead?.address || "",
    postcode: lead?.postcode || "",
    propertyType: lead?.propertyType || "",
    isHomeowner: lead?.isHomeowner || "",
    booking: {
      preferred_day: booking?.preferred_day || "",
      preferred_window: booking?.preferred_window || "",
      confirmed_address: booking?.confirmed_address || "",
      notes: booking?.notes || ""
    }
  };

  const r = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`GHL webhook failed: ${r.status} ${errText}`);
  }
}

// Handle incoming Twilio voice requests
app.post("/twilio/voice", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const name = req.query.name || "there";
  const phone = req.query.phone || "";
  const email = req.query.email || "";
  const address = req.query.address || "";
  const postcode = req.query.postcode || "";
  const propertyType = req.query.propertyType || "";
  const isHomeowner = req.query.isHomeowner || "";

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

// Handle speech input (gather day and window)
app.post("/twilio/speech", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult || "";
  const session = ensureSession(callSid);

  if (speech) session.transcript.push({ role: "user", text: speech });

  console.log("Speech result:", speech);

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

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(baseUrl, "I didn’t catch that. Can you repeat it?")}</Play>
  <Redirect method="POST">${baseUrl}/twilio/next</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// The `/twilio/next` can now manage flow as needed for the conversation

// -------------------- Call status callback --------------------
app.post("/twilio/status", (req, res) => {
  const payload = req.body;
  console.log("Call status:", payload);
  res.status(200).send("ok");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
