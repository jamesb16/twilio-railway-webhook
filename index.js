const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ------------------ ENV ------------------
const {
  PUBLIC_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  OPENAI_API_KEY,
  GHL_BOOKING_TRIGGER_URL // <-- paste "number 3" here in Railway Variables
} = process.env;

const AGENT_NAME = process.env.AGENT_NAME || "Nicola";
const COMPANY_NAME = process.env.COMPANY_NAME || "Greenbug Energy";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "8", 10);

// In-memory call state (fine for now)
const callState = new Map(); // CallSid -> { turns, leadName, leadPhone, history[], formData{} }

// ------------------ HEALTH ------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug Energy outbound caller running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ------------------ ELEVENLABS TTS ------------------
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "").toString();
    if (!text) return res.status(400).send("Missing text");
    if (!ELEVENLABS_API_KEY) return res.status(500).send("Missing ELEVENLABS_API_KEY");
    if (!ELEVENLABS_VOICE_ID) return res.status(500).send("Missing ELEVENLABS_VOICE_ID");

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}/stream`;

    const payload = {
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: {
        stability: 0.55,
        similarity_boost: 0.8,
        style: 0.25,
        use_speaker_boost: true
      }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify(payload)
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

// ------------------ (A) SEND TEST PAYLOAD TO GHL (for Mapping Reference) ------------------
// Hit this in browser: https://YOUR-RAILWAY/send-test-to-ghl
app.get("/send-test-to-ghl", async (req, res) => {
  try {
    if (!GHL_BOOKING_TRIGGER_URL) {
      return res.status(500).json({ ok: false, error: "Missing GHL_BOOKING_TRIGGER_URL env var" });
    }

    const sample = {
      intent: "BOOK",
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      phone: "+447700900123",
      first_name: "Test",
      last_name: "Lead",
      email: "test@example.com",
      address: "1 Test Street",
      city: "Glasgow",
      postcode: "G1 1AA",
      property_type: "House",
      homeowner: "Yes",
      preferred_day: "Next week",
      preferred_time_window: "Morning",
      notes: "Test payload to create mapping reference in GHL"
    };

    const r = await fetch(GHL_BOOKING_TRIGGER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sample)
    });

    const text = await r.text();
    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      message: "Sent sample payload to GHL inbound webhook trigger URL.",
      ghl_response: text.slice(0, 500)
    });
  } catch (e) {
    console.error("send-test-to-ghl error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------ (A) SEND REAL OUTCOME TO GHL ------------------
async function sendToGhl(payload) {
  if (!GHL_BOOKING_TRIGGER_URL) return;
  try {
    await fetch(GHL_BOOKING_TRIGGER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("sendToGhl failed:", e);
  }
}

// ------------------ OUTBOUND CALL TRIGGER FROM GHL (lead submitted) ------------------
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    const phoneRaw =
      body.phone || body.Phone ||
      body.contact?.phone || body.contact?.phoneNumber || body.contact?.phone_number;

    const leadName =
      body.name || body.full_name || body.fullName ||
      body.contact?.name || body.contact?.firstName || body.contact?.first_name ||
      "there";

    if (!phoneRaw) return res.status(400).json({ ok: false, error: "Missing phone in payload" });

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
      return res.status(500).json({ ok: false, error: "Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER" });
    }
    if (!PUBLIC_BASE_URL) return res.status(500).json({ ok: false, error: "Missing PUBLIC_BASE_URL" });

    const to = String(phoneRaw).trim();
    const from = TWILIO_FROM_NUMBER;

    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
      to,
      from,
      url: `${PUBLIC_BASE_URL}/twilio/voice?leadName=${encodeURIComponent(leadName)}&leadPhone=${encodeURIComponent(to)}`,
      method: "POST",
      statusCallback: `${PUBLIC_BASE_URL}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    return res.status(200).json({ ok: true, message: "Call triggered", sid: call.sid, to, leadName });
  } catch (e) {
    console.error("Error in /ghl/lead:", e);
    return res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
});

// ------------------ TWILIO: START CALL ------------------
app.post("/twilio/voice", (req, res) => {
  const leadName = (req.query.leadName || "there").toString();
  const leadPhone = (req.query.leadPhone || "").toString();
  const callSid = (req.body.CallSid || req.query.CallSid || "").toString();

  if (!callState.has(callSid)) {
    callState.set(callSid, {
      turns: 0,
      leadName,
      leadPhone,
      formData: {}, // later: store postcode/address confirmation etc.
      history: [
        {
          role: "system",
          content:
            `You are ${AGENT_NAME}, a friendly UK caller for ${COMPANY_NAME}. ` +
            `You are calling a lead about SOLAR panels / a free home energy survey. ` +
            `Goal: confirm key details quickly (address/postcode), check homeowner status, then book a site survey. ` +
            `Be human, warm, not salesy. Keep responses short. Never mention you are AI. ` +
            `If they want later, arrange callback time. If not eligible (not homeowner), politely end. ` +
            `When ready to book: ask preferred day + morning/afternoon.`
        }
      ]
    });
  }

  const opener =
    `Hi ${leadName}, it’s ${AGENT_NAME} from ${COMPANY_NAME}. ` +
    `You’ve just checked availability for a free home energy survey for solar. ` +
    `Have I caught you at an okay time for a quick minute?`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(opener)}</Play>
  <Gather input="speech" action="/twilio/turn?CallSid=${encodeURIComponent(callSid)}" method="POST" speechTimeout="auto" />
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent("No worries — I’ll text you so you can pick a better time. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ------------------ TWILIO: CONVERSATION TURN ------------------
app.post("/twilio/turn", async (req, res) => {
  const callSid = (req.query.CallSid || req.body.CallSid || "").toString();
  const speech = (req.body.SpeechResult || "").toString().trim();

  const state = callState.get(callSid);
  if (!state) {
    return res.type("text/xml").send(makePlayAndHangup("Sorry — something went wrong. I’ll text you shortly. Bye for now."));
  }

  state.turns += 1;
  console.log("TURN", { callSid, turn: state.turns, speech });

  if (!speech) {
    return res.type("text/xml").send(makePlayAndHangup("No worries — I’ll text you a link to choose a time. Bye for now."));
  }

  if (state.turns >= MAX_TURNS) {
    return res.type("text/xml").send(makePlayAndHangup("Thanks — I won’t keep you. I’ll text you the next steps. Bye for now."));
  }

  state.history.push({ role: "user", content: speech });

  let ai;
  try {
    ai = await getNextFromOpenAI(state.history);
  } catch (e) {
    console.error("OpenAI error:", e);
    return res.type("text/xml").send(makePlayAndHangup("Sorry — I’m having a quick technical issue. I’ll text you shortly to arrange the survey. Bye for now."));
  }

  const { reply, action, extracted } = ai;

  // Save any extracted fields (postcode/address/time window etc.)
  if (extracted && typeof extracted === "object") {
    state.formData = { ...state.formData, ...extracted };
  }

  state.history.push({ role: "assistant", content: reply });
  callState.set(callSid, state);

  // When action triggers, POST to GHL inbound webhook (A)
  if (action === "BOOK" || action === "CALLBACK" || action === "END") {
    await sendToGhl({
      intent: action,
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      phone: state.leadPhone,
      first_name: state.leadName,
      ...state.formData,
      last_user: speech,
      agent_reply: reply
    });

    const closing =
      action === "BOOK"
        ? `${reply} Perfect — I’ll text you the details now. Bye for now.`
        : action === "CALLBACK"
          ? `${reply} No problem — I’ll arrange that and text you. Bye for now.`
          : `${reply}`;

    return res.type("text/xml").send(makePlayAndHangup(closing));
  }

  // Continue conversation
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(reply)}</Play>
  <Gather input="speech" action="/twilio/turn?CallSid=${encodeURIComponent(callSid)}" method="POST" speechTimeout="auto" />
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent("Sorry, I didn’t catch that. I’ll text you so you can pick a time. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ------------------ TWILIO STATUS ------------------
app.post("/twilio/status", (req, res) => {
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration
  };
  console.log("Call status:", payload);

  if (payload.CallStatus === "completed") {
    callState.delete(payload.CallSid);
  }
  res.status(200).send("ok");
});

// ------------------ OPENAI (SOLAR QUALIFICATION + BOOKING) ------------------
async function getNextFromOpenAI(history) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const extraSystem = {
    role: "system",
    content:
      `Return ONLY valid JSON like: {"reply":"...","action":"CONTINUE|BOOK|CALLBACK|END","extracted":{...}}.\n` +
      `Use extracted for: postcode, address_confirmed, homeowner, property_type, preferred_day, preferred_time_window.\n` +
      `BOOK when you have: homeowner=yes AND at least postcode (or address confirmed) AND preferred_day + preferred_time_window.\n` +
      `CALLBACK if they ask to be called later and give a time/day.\n` +
      `END if not homeowner / not interested / wrong number.\n` +
      `Tone: human UK phone call, short, warm, not salesy.\n`
  };

  const messages = [...history, extraSystem];

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.5,
      messages
    })
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
    parsed = { reply: content.slice(0, 220), action: "CONTINUE", extracted: {} };
  }

  const reply = (parsed.reply || "").toString().trim() || "Okay — just a quick one: are you the homeowner at the property?";
  const actionRaw = (parsed.action || "CONTINUE").toString().toUpperCase();
  const action = ["CONTINUE", "BOOK", "CALLBACK", "END"].includes(actionRaw) ? actionRaw : "CONTINUE";
  const extracted = parsed.extracted && typeof parsed.extracted === "object" ? parsed.extracted : {};

  return { reply, action, extracted };
}

function makePlayAndHangup(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(text)}</Play>
  <Hangup/>
</Response>`;
}

// ------------------ START ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
