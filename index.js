/**
 * Greenbug Energy - Outbound AI Caller (Nicola)
 * - GHL webhook triggers outbound call
 * - Twilio voice webhooks serve TwiML with <Play> to ElevenLabs TTS endpoint
 * - Conversational loop: Twilio speech -> OpenAI -> next prompt -> repeat
 *
 * Required env vars:
 *  PUBLIC_BASE_URL          = https://twilio-railway-webhook-production.up.railway.app
 *  TWILIO_ACCOUNT_SID       = ACxxxx
 *  TWILIO_AUTH_TOKEN        = xxxxx
 *  TWILIO_FROM_NUMBER       = +44....
 *  OPENAI_API_KEY           = sk-...
 *  ELEVENLABS_API_KEY       = xxxxx
 *  ELEVENLABS_VOICE_ID      = Flx6Swjd7o5h8giaG5Qk
 *
 * Optional:
 *  AGENT_NAME               = Nicola
 *  COMPANY_NAME             = Greenbug Energy
 *  MAX_TURNS                = 8
 *  RESULT_WEBHOOK_URL       = (optional) send outcome to your CRM/GHL webhook
 */

const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ------------------ Config ------------------
const {
  PUBLIC_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  RESULT_WEBHOOK_URL,
} = process.env;

const AGENT_NAME = process.env.AGENT_NAME || "Nicola";
const COMPANY_NAME = process.env.COMPANY_NAME || "Greenbug Energy";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "8", 10);

// Simple in-memory state per call (fine to start; later move to Redis/DB)
const callState = new Map(); // CallSid -> { turns, history: [{role,content}], leadName, leadPhone }

// ------------------ Health ------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug Energy outbound caller running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ------------------ ElevenLabs TTS ------------------
// Example: /tts?text=Hello+there
app.get("/tts", async (req, res) => {
  try {
    const text = (req.query.text || "").toString();
    if (!text) return res.status(400).send("Missing text");
    if (!ELEVENLABS_API_KEY) return res.status(500).send("Missing ELEVENLABS_API_KEY");
    if (!ELEVENLABS_VOICE_ID) return res.status(500).send("Missing ELEVENLABS_VOICE_ID");

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      ELEVENLABS_VOICE_ID
    )}/stream`;

    // Keep it short-ish per request (Twilio likes fast responses)
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
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("ElevenLabs error:", r.status, errText);
      return res.status(500).send("TTS failed");
    }

    res.setHeader("Content-Type", "audio/mpeg");
    // Stream audio back to Twilio
    r.body.pipe(res);
  } catch (e) {
    console.error("TTS exception:", e);
    res.status(500).send("TTS exception");
  }
});

// ------------------ GHL webhook -> trigger outbound call ------------------
app.post("/ghl/lead", async (req, res) => {
  try {
    const body = req.body || {};

    // try common GHL payload paths
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

    if (!phoneRaw) return res.status(400).json({ ok: false, error: "Missing phone in payload" });

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
      return res.status(500).json({ ok: false, error: "Missing Twilio env vars" });
    }
    if (!PUBLIC_BASE_URL) {
      return res.status(500).json({ ok: false, error: "Missing PUBLIC_BASE_URL" });
    }

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
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    return res.status(200).json({ ok: true, message: "Call triggered", sid: call.sid, to, leadName });
  } catch (e) {
    console.error("Error in /ghl/lead:", e);
    return res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
});

// ------------------ Twilio: start of call ------------------
app.post("/twilio/voice", (req, res) => {
  const leadName = (req.query.leadName || "there").toString();
  const leadPhone = (req.query.leadPhone || "").toString();
  const callSid = (req.body.CallSid || req.query.CallSid || "").toString();

  // init state
  if (!callState.has(callSid)) {
    callState.set(callSid, {
      turns: 0,
      leadName,
      leadPhone,
      history: [
        {
          role: "system",
          content:
            `You are ${AGENT_NAME}, a friendly human-sounding phone agent for ${COMPANY_NAME} in the UK. ` +
            `You are calling a lead who just submitted a form requesting a callback about a site survey. ` +
            `Your job: qualify briefly, answer questions, and book a site survey. ` +
            `Keep it natural, concise, and conversational. No robotic phrasing. ` +
            `If the lead wants later, agree and ask for best time. ` +
            `If they agree to book, collect postcode and preferred day/time window. ` +
            `Never mention you are AI.`
        }
      ],
    });
  }

  // First spoken line from Nicola
  const firstLine =
    `Hi ${leadName}, it’s ${AGENT_NAME} calling from ${COMPANY_NAME}. ` +
    `You’ve just asked us to call you back about a site survey. ` +
    `Have I caught you at an okay time for a quick minute?`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(firstLine)}</Play>

  <Gather input="speech" action="/twilio/turn?CallSid=${encodeURIComponent(callSid)}" method="POST" speechTimeout="auto" />
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent("Sorry, I didn’t catch that. I’ll send a quick text so you can pick a time. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ------------------ Twilio: each conversational turn ------------------
app.post("/twilio/turn", async (req, res) => {
  const callSid = (req.query.CallSid || req.body.CallSid || "").toString();
  const speech = (req.body.SpeechResult || "").toString().trim();
  const confidence = req.body.Confidence;

  const state = callState.get(callSid) || { turns: 0, history: [] };
  state.turns = (state.turns || 0) + 1;

  console.log("TURN", { callSid, turn: state.turns, speech, confidence });

  // if silence / nothing
  if (!speech) {
    const msg = "No worries — I’ll text you a link to choose a time. Bye for now.";
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(msg));
  }

  // hard stop if too many turns
  if (state.turns >= MAX_TURNS) {
    const msg = "Thanks — I don’t want to keep you. I’ll text you the next steps. Bye for now.";
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(msg));
  }

  // Add user speech to history
  state.history.push({ role: "user", content: speech });

  // Ask OpenAI for the next line + action tag
  let ai;
  try {
    ai = await getNextFromOpenAI(state.history);
  } catch (e) {
    console.error("OpenAI error:", e);
    const msg = "Sorry — I’m having a quick technical issue. I’ll text you shortly to arrange the survey. Bye for now.";
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(msg));
  }

  const { reply, action } = ai;
  state.history.push({ role: "assistant", content: reply });
  callState.set(callSid, state);

  // If booking confirmed, we can send outcome webhook (stub) + end
  if (action === "BOOK") {
    await sendResultWebhookSafe({
      callSid,
      outcome: "BOOK",
      leadName: state.leadName,
      leadPhone: state.leadPhone,
      lastUserUtterance: speech,
      agentReply: reply,
      transcript: compactTranscript(state.history),
    });

    const closing = reply + " Thanks — I’ll get that booked and text you the details. Bye for now.";
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(closing));
  }

  if (action === "CALLBACK") {
    await sendResultWebhookSafe({
      callSid,
      outcome: "CALLBACK",
      leadName: state.leadName,
      leadPhone: state.leadPhone,
      lastUserUtterance: speech,
      agentReply: reply,
      transcript: compactTranscript(state.history),
    });

    const closing = reply + " No problem — I’ll arrange a callback. Bye for now.";
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(closing));
  }

  if (action === "END") {
    await sendResultWebhookSafe({
      callSid,
      outcome: "END",
      leadName: state.leadName,
      leadPhone: state.leadPhone,
      lastUserUtterance: speech,
      agentReply: reply,
      transcript: compactTranscript(state.history),
    });

    return res.type("text/xml").send(makeTwiMLPlayAndHangup(reply));
  }

  // Default: continue conversation
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(reply)}</Play>
  <Gather input="speech" action="/twilio/turn?CallSid=${encodeURIComponent(callSid)}" method="POST" speechTimeout="auto" />
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent("Sorry, I didn’t catch that. I’ll text you a link to pick a time. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ------------------ Twilio call status callback ------------------
app.post("/twilio/status", (req, res) => {
  const payload = {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration,
    Timestamp: req.body.Timestamp,
  };
  console.log("Call status:", payload);

  // Cleanup memory when completed
  if (payload.CallStatus === "completed") {
    callState.delete(payload.CallSid);
  }

  res.status(200).send("ok");
});

// ------------------ OpenAI helper ------------------
async function getNextFromOpenAI(history) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // We request a strict tiny JSON back so it's predictable.
  const prompt = [
    ...history,
    {
      role: "system",
      content:
        `Return ONLY valid JSON: {"reply":"...","action":"CONTINUE|BOOK|CALLBACK|END"}. ` +
        `- BOOK only when the lead clearly agrees to book and you have at least postcode + a day/time window OR you are ready to confirm next step.\n` +
        `- CALLBACK if they ask to be called later and give a time/day preference.\n` +
        `- END if they are not interested / wrong number / hostile.\n` +
        `Reply must be natural UK phone style, short, friendly, human.\n`
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
      messages: prompt,
    }),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${txt}`);
  }

  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content || "";

  // Parse JSON safely
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // fallback if model misbehaves
    parsed = { reply: content.slice(0, 220), action: "CONTINUE" };
  }

  const reply = (parsed.reply || "").toString().trim() || "Okay — tell me a bit more about that.";
  const actionRaw = (parsed.action || "CONTINUE").toString().toUpperCase();
  const action = ["CONTINUE", "BOOK", "CALLBACK", "END"].includes(actionRaw) ? actionRaw : "CONTINUE";

  return { reply, action };
}

// ------------------ Result webhook (optional) ------------------
async function sendResultWebhookSafe(payload) {
  try {
    if (!RESULT_WEBHOOK_URL) return;
    await fetch(RESULT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Result webhook failed:", e);
  }
}

function compactTranscript(history) {
  return history
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => `${m.role === "user" ? "Lead" : AGENT_NAME}: ${m.content}`)
    .join("\n");
}

function makeTwiMLPlayAndHangup(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(text)}</Play>
  <Hangup/>
</Response>`;
}

// IMPORTANT: Railway port
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
