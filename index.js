/**
 * Greenbug Energy - Solar Survey Caller (Nicola)
 * - GHL lead webhook triggers outbound call
 * - Twilio plays ElevenLabs TTS audio
 * - Conversational loop via OpenAI
 * - When AI decides BOOK -> POST to GHL inbound webhook trigger URL (GHL_BOOKING_TRIGGER_URL)
 *
 * ENV REQUIRED:
 *  PUBLIC_BASE_URL
 *  TWILIO_ACCOUNT_SID
 *  TWILIO_AUTH_TOKEN
 *  TWILIO_FROM_NUMBER
 *  ELEVENLABS_API_KEY
 *  ELEVENLABS_VOICE_ID
 *  OPENAI_API_KEY
 *
 * ENV FOR BOOKING (WEBHOOK approach):
 *  GHL_BOOKING_TRIGGER_URL   (leadconnector inbound webhook URL)
 *
 * OPTIONAL:
 *  AGENT_NAME=Nicola
 *  COMPANY_NAME=Greenbug Energy
 *  MAX_TURNS=8
 */

const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const {
  PUBLIC_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  OPENAI_API_KEY,
  GHL_BOOKING_TRIGGER_URL,
} = process.env;

const AGENT_NAME = process.env.AGENT_NAME || "Nicola";
const COMPANY_NAME = process.env.COMPANY_NAME || "Greenbug Energy";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "8", 10);

// In-memory call state (fine for now)
const callState = new Map(); // CallSid -> { turns, history, leadName, leadPhone, leadEmail, leadAddress, leadPostcode, propertyType, homeowner }

// ------------------- Health -------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug Energy caller running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ------------------- ElevenLabs TTS -------------------
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "").toString();
    if (!text) return res.status(400).send("Missing text");
    if (!ELEVENLABS_API_KEY) return res.status(500).send("Missing ELEVENLABS_API_KEY");
    if (!ELEVENLABS_VOICE_ID) return res.status(500).send("Missing ELEVENLABS_VOICE_ID");

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      ELEVENLABS_VOICE_ID
    )}/stream`;

    const payload = {
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.55,
        similarity_boost: 0.8,
        style: 0.25,
        use_speaker_boost: true,
      },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("ElevenLabs error:", r.status, errText);
      return res.status(500).send("TTS failed");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    r.body.pipe(res);
  } catch (e) {
    console.error("TTS exception:", e);
    res.status(500).send("TTS exception");
  }
});

// ------------------- GHL lead webhook -> trigger outbound call -------------------
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    const phoneRaw =
      body.phone ||
      body.Phone ||
      body.contact?.phone ||
      body.contact?.phoneNumber ||
      body.contact?.phone_number;

    const leadName =
      body.name ||
      body.full_name ||
      body.fullName ||
      body.contact?.name ||
      body.contact?.firstName ||
      body.contact?.first_name ||
      "there";

    const leadEmail = body.email || body.Email || body.contact?.email || "";
    const leadAddress =
      body.address ||
      body.Address ||
      body.contact?.address1 ||
      body.contact?.address ||
      body.streetAddress ||
      "";
    const leadPostcode =
      body.postalCode ||
      body.postcode ||
      body.PostalCode ||
      body.Postcode ||
      body.contact?.postalCode ||
      body.contact?.postcode ||
      "";

    const propertyType = body.propertyType || body["Property Type"] || body.property_type || "";
    const homeowner = body.homeowner || body["Are You The Homeowner"] || body.areYouTheHomeowner || "";

    if (!phoneRaw) return res.status(400).json({ ok: false, error: "Missing phone in payload" });
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
      return res.status(500).json({ ok: false, error: "Missing Twilio env vars" });
    }
    if (!PUBLIC_BASE_URL) return res.status(500).json({ ok: false, error: "Missing PUBLIC_BASE_URL" });

    const to = String(phoneRaw).trim();
    const from = TWILIO_FROM_NUMBER;

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
      to,
      from,
      url: `${PUBLIC_BASE_URL}/twilio/voice?leadName=${encodeURIComponent(
        leadName
      )}&leadPhone=${encodeURIComponent(to)}&leadEmail=${encodeURIComponent(leadEmail)}&leadAddress=${encodeURIComponent(
        leadAddress
      )}&leadPostcode=${encodeURIComponent(leadPostcode)}&propertyType=${encodeURIComponent(propertyType)}&homeowner=${encodeURIComponent(
        homeowner
      )}`,
      method: "POST",
      statusCallback: `${PUBLIC_BASE_URL}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    return res.status(200).json({ ok: true, message: "Call triggered", sid: call.sid, to, leadName });
  } catch (e) {
    console.error("Error in /ghl/lead:", e);
    return res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
});

// ------------------- Twilio: start of call -------------------
app.post("/twilio/voice", (req, res) => {
  const leadName = (req.query.leadName || "there").toString();
  const leadPhone = (req.query.leadPhone || "").toString();
  const leadEmail = (req.query.leadEmail || "").toString();
  const leadAddress = (req.query.leadAddress || "").toString();
  const leadPostcode = (req.query.leadPostcode || "").toString();
  const propertyType = (req.query.propertyType || "").toString();
  const homeowner = (req.query.homeowner || "").toString();

  const callSid = (req.body.CallSid || "").toString();

  if (!callState.has(callSid)) {
    callState.set(callSid, {
      turns: 0,
      leadName,
      leadPhone,
      leadEmail,
      leadAddress,
      leadPostcode,
      propertyType,
      homeowner,
      history: [
        {
          role: "system",
          content:
            `You are ${AGENT_NAME}, a friendly human-sounding UK phone agent for ${COMPANY_NAME}. ` +
            `You are calling a lead about SOLAR PANELS who just submitted the "Energy Survey" form requesting a callback. ` +
            `Goal: confirm key details quickly, answer questions, and book a FREE home energy survey. ` +
            `Be warm and natural. Avoid robotic phrasing. Never say you are AI. ` +
            `If the lead is busy, offer to call back and ask best time. ` +
            `If they are not homeowner, politely end (or ask if homeowner is available). ` +
            `Keep questions minimal: confirm address/postcode, homeowner, property type, and a quick suitability check (roof/shading). ` +
            `Then book a survey.`
        },
        {
          role: "system",
          content:
            `Known form details (may be empty): ` +
            `Name=${leadName}; Phone=${leadPhone}; Email=${leadEmail}; Address=${leadAddress}; Postcode=${leadPostcode}; ` +
            `PropertyType=${propertyType}; Homeowner=${homeowner}.`
        }
      ],
    });
  }

  const firstLine =
    `Hi ${leadName}, it’s ${AGENT_NAME} from ${COMPANY_NAME}. ` +
    `You’ve just filled in our form about solar panels and a free home energy survey. ` +
    `Have I caught you at an okay time for a quick minute?`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(firstLine)}</Play>
  <Gather input="speech" action="/twilio/turn?CallSid=${encodeURIComponent(callSid)}" method="POST" speechTimeout="auto" />
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent("Sorry, I didn’t catch that. I’ll send you a quick text to pick a time. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ------------------- Twilio: conversation turn -------------------
app.post("/twilio/turn", async (req, res) => {
  const callSid = (req.query.CallSid || req.body.CallSid || "").toString();
  const speech = (req.body.SpeechResult || "").toString().trim();
  const confidence = req.body.Confidence;

  const state = callState.get(callSid);
  if (!state) return res.type("text/xml").send(makeTwiMLPlayAndHangup("Sorry, something went wrong. Bye for now."));

  state.turns += 1;
  console.log("TURN", { callSid, turn: state.turns, speech, confidence });

  if (!speech) {
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("No worries — I’ll text you a link to choose a time. Bye for now."));
  }

  if (state.turns >= MAX_TURNS) {
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("Thanks — I won’t keep you. I’ll text you the next steps. Bye for now."));
  }

  state.history.push({ role: "user", content: speech });

  let ai;
  try {
    ai = await getNextFromOpenAI(state);
  } catch (e) {
    console.error("OpenAI error:", e);
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("Sorry — I’m having a quick technical issue. I’ll text you shortly to arrange the survey. Bye for now."));
  }

  const { reply, action, booking_payload } = ai;
  state.history.push({ role: "assistant", content: reply });
  callState.set(callSid, state);

  // If BOOK -> fire webhook into GHL booking workflow
  if (action === "BOOK") {
    const payload = {
      intent: "BOOK",
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      callSid,
      lead: {
        name: state.leadName,
        phone: state.leadPhone,
        email: state.leadEmail,
        address: state.leadAddress,
        postcode: state.leadPostcode,
        propertyType: state.propertyType,
        homeowner: state.homeowner,
      },
      booking: booking_payload || {},
      transcript: compactTranscript(state.history, AGENT_NAME),
    };

    const sent = await postToGhlBookingTrigger(payload);
    console.log("BOOK webhook sent?", sent);

    // Don’t promise an exact time; let GHL text details
    const closing = `${reply} Perfect — I’ll get that booked in and text you the details now. Bye for now.`;
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(closing));
  }

  if (action === "CALLBACK") {
    const payload = {
      intent: "CALLBACK",
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      callSid,
      lead: {
        name: state.leadName,
        phone: state.leadPhone,
        email: state.leadEmail,
        address: state.leadAddress,
        postcode: state.leadPostcode,
      },
      transcript: compactTranscript(state.history, AGENT_NAME),
    };
    await postToGhlBookingTrigger(payload); // same trigger can route based on intent
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(`${reply} No problem — I’ll send a text and arrange a better time. Bye for now.`));
  }

  if (action === "END") {
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(reply));
  }

  // Continue loop
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(reply)}</Play>
  <Gather input="speech" action="/twilio/turn?CallSid=${encodeURIComponent(callSid)}" method="POST" speechTimeout="auto" />
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent("Sorry, I didn’t catch that. I’ll text you a link to pick a time. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ------------------- Twilio status callback -------------------
app.post("/twilio/status", (req, res) => {
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration,
  };
  console.log("Call status:", payload);

  if (payload.CallStatus === "completed") {
    callState.delete(payload.CallSid);
  }
  res.status(200).send("ok");
});

// ------------------- TEST: send a sample payload to GHL inbound webhook -------------------
// Use this to create the "Mapping Reference" so the trigger can be saved.
app.get("/send-test-to-ghl", async (req, res) => {
  try {
    if (!GHL_BOOKING_TRIGGER_URL) {
      return res.status(500).json({ ok: false, error: "Missing GHL_BOOKING_TRIGGER_URL env var" });
    }

    const payload = {
      intent: "BOOK",
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      lead: {
        name: "Test Lead",
        phone: "+447700900123",
        email: "test@example.com",
        address: "1 Test Street",
        postcode: "G1 1AA",
        propertyType: "Detached",
        homeowner: "Yes",
      },
      booking: {
        preferred_day: "next week",
        preferred_window: "afternoon",
        notes: "Test mapping reference payload",
      },
      transcript: "Lead: I’d like solar.\nNicola: Great, I’ll book a survey.",
    };

    const ok = await postJson(GHL_BOOKING_TRIGGER_URL, payload);
    return res.status(200).json({ ok: true, sent: ok });
  } catch (e) {
    console.error("send-test-to-ghl error:", e);
    res.status(500).json({ ok: false, error: e.message || "unknown" });
  }
});

// ------------------- OpenAI helper -------------------
async function getNextFromOpenAI(state) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const { leadName, leadAddress, leadPostcode, propertyType, homeowner } = state;

  const messages = [
    ...state.history,
    {
      role: "system",
      content:
        `Return ONLY valid JSON: {"reply":"...","action":"CONTINUE|BOOK|CALLBACK|END","booking_payload":{...}}.\n` +
        `Context: You are booking a FREE home energy survey for SOLAR PANELS.\n` +
        `Try not to ask for things we already have. Known: address="${leadAddress}", postcode="${leadPostcode}", propertyType="${propertyType}", homeowner="${homeowner}".\n` +
        `If homeowner is unclear, confirm it. Confirm address/postcode briefly.\n` +
        `Ask 1-2 quick suitability questions max (roof direction/shading).\n` +
        `When ready to book, action=BOOK and include booking_payload with preferred_day/preferred_window plus any notes.\n` +
        `If they want later, action=CALLBACK and include callback_day/callback_window in booking_payload.\n` +
        `If not interested/wrong number, action=END.\n` +
        `Keep reply short, friendly, UK natural phone style.`
    }
  ];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.5,
      messages,
    }),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${txt}`);
  }

  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content || "";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { reply: content.slice(0, 240), action: "CONTINUE", booking_payload: {} };
  }

  const reply = (parsed.reply || "").toString().trim() || "Okay — tell me a bit more about that.";
  const actionRaw = (parsed.action || "CONTINUE").toString().toUpperCase();
  const action = ["CONTINUE", "BOOK", "CALLBACK", "END"].includes(actionRaw) ? actionRaw : "CONTINUE";

  return { reply, action, booking_payload: parsed.booking_payload || {} };
}

// ------------------- Post to GHL booking trigger -------------------
async function postToGhlBookingTrigger(payload) {
  if (!GHL_BOOKING_TRIGGER_URL) {
    console.error("Missing GHL_BOOKING_TRIGGER_URL env var");
    return false;
  }
  return await postJson(GHL_BOOKING_TRIGGER_URL, payload);
}

async function postJson(url, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("POST failed:", r.status, t);
    return false;
  }
  return true;
}

function compactTranscript(history, agentName) {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Lead" : agentName}: ${m.content}`)
    .join("\n");
}

function makeTwiMLPlayAndHangup(text) {
  if (!PUBLIC_BASE_URL) {
    // fallback
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(text)}</Say><Hangup/></Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(text)}</Play>
  <Hangup/>
</Response>`;
}

function escapeXml(unsafe) {
  return (unsafe || "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ------------------- Listen -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
