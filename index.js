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
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  GHL_INBOUND_WEBHOOK_URL
} = process.env;

const AGENT_NAME = process.env.AGENT_NAME || "Nicola";
const COMPANY_NAME = process.env.COMPANY_NAME || "Greenbug Energy";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "8", 10);

// In-memory call state
const callState = new Map(); // CallSid -> { turns, history, leadName, leadPhone, leadEmail, address, postcode, homeowner }

// ------------------ Health ------------------
app.get("/", (req, res) => res.status(200).send("OK - Greenbug Energy outbound caller running"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ------------------ ElevenLabs TTS ------------------
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

// ------------------ TEST: send a sample payload to GHL inbound webhook ------------------
// This is ONLY to fix the "Mapping reference required" error in GHL.
// You call this once, then pick the mapping in GHL and save the trigger.
app.post("/send-test-to-ghl", async (req, res) => {
  try {
    if (!GHL_INBOUND_WEBHOOK_URL) {
      return res.status(500).json({ ok: false, error: "Missing GHL_INBOUND_WEBHOOK_URL env var" });
    }

    const sample = {
      intent: "BOOK",
      source: "AI_CALL",
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      phone: "+447000000000",
      first_name: "Test",
      email: "test@example.com",
      address: "1 High Street",
      postcode: "G1 1AA",
      homeowner: "Yes",
      preferred_window: "Next week - afternoon",
      transcript: "Lead: Yes please book.\nNicola: Perfect, I’ll get you booked and text details.",
      callSid: "TEST_CALLSID"
    };

    const r = await fetch(GHL_INBOUND_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sample)
    });

    const txt = await r.text();
    return res.status(200).json({ ok: true, status: r.status, response: txt.slice(0, 300) });
  } catch (e) {
    console.error("send-test-to-ghl error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------ Outbound call trigger from GHL ------------------
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

    const leadEmail = body.email || body.contact?.email || "";
    const address = body.address || body.contact?.address1 || body.contact?.address || "";
    const postcode = body.postalCode || body.postcode || body.contact?.postalCode || body.contact?.postcode || "";
    const homeowner = body.homeowner || body["Are You The Homeowner"] || "";

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
      url: `${PUBLIC_BASE_URL}/twilio/voice?leadName=${encodeURIComponent(leadName)}&leadPhone=${encodeURIComponent(to)}&leadEmail=${encodeURIComponent(leadEmail)}&address=${encodeURIComponent(address)}&postcode=${encodeURIComponent(postcode)}&homeowner=${encodeURIComponent(homeowner)}`,
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

// ------------------ Twilio: start of call ------------------
app.post("/twilio/voice", (req, res) => {
  const leadName = (req.query.leadName || "there").toString();
  const leadPhone = (req.query.leadPhone || "").toString();
  const leadEmail = (req.query.leadEmail || "").toString();
  const address = (req.query.address || "").toString();
  const postcode = (req.query.postcode || "").toString();
  const homeowner = (req.query.homeowner || "").toString();

  const callSid = (req.body.CallSid || req.query.CallSid || "").toString();

  if (!callState.has(callSid)) {
    callState.set(callSid, {
      turns: 0,
      leadName,
      leadPhone,
      leadEmail,
      address,
      postcode,
      homeowner,
      history: [
        {
          role: "system",
          content:
            `You are ${AGENT_NAME}, a friendly human-sounding phone agent for ${COMPANY_NAME} in the UK. ` +
            `You are calling a lead who filled out a form about SOLAR PANELS / a free home energy survey. ` +
            `Goal: confirm key details quickly and book a site survey. ` +
            `Be natural, warm, and confident. No robotic wording. Never say you are AI.\n\n` +
            `Rules:\n` +
            `- Start by confirming it's a good time.\n` +
            `- Confirm address/postcode if missing or unclear.\n` +
            `- Ask only the minimum: homeowner? property type? daytime availability? best contact.\n` +
            `- Handle objections: cost, "just browsing", "send info" -> offer quick survey booking.\n` +
            `- If they want later, ask best day/time window.\n` +
            `- When ready to book, collect a preferred day/time window (morning/afternoon) and confirm you'll text details.\n\n` +
            `Return ONLY JSON: {"reply":"...","action":"CONTINUE|BOOK|CALLBACK|END","fields":{"preferred_window":"","notes":"","confirm_address":""}}`
        }
      ]
    });
  }

  const state = callState.get(callSid);

  const opener =
    `Hi ${leadName}, it’s ${AGENT_NAME} from ${COMPANY_NAME}. ` +
    `You’ve just checked availability for a free home energy survey about solar panels. ` +
    `Have I caught you at an okay time for a quick minute?`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(opener)}</Play>
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

  const state = callState.get(callSid);
  if (!state) return res.type("text/xml").send(makeTwiMLPlayAndHangup("Sorry — something went wrong. Bye for now."));

  state.turns += 1;

  if (!speech) return res.type("text/xml").send(makeTwiMLPlayAndHangup("No worries — I’ll text you a link to choose a time. Bye for now."));

  if (state.turns >= MAX_TURNS) {
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("Thanks — I don’t want to keep you. I’ll text you the next steps. Bye for now."));
  }

  state.history.push({ role: "user", content: speech });

  let ai = { reply: "Okay — tell me a bit more.", action: "CONTINUE", fields: {} };
  try {
    ai = await getNextFromOpenAI(state.history);
  } catch (e) {
    console.error("OpenAI error:", e);
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("Sorry — quick technical issue. I’ll text you shortly to arrange the survey. Bye for now."));
  }

  const reply = (ai.reply || "").toString().trim() || "Okay — tell me a bit more.";
  const action = (ai.action || "CONTINUE").toString().toUpperCase();
  const fields = ai.fields || {};

  state.history.push({ role: "assistant", content: reply });
  callState.set(callSid, state);

  // If BOOK/CALLBACK/END -> send webhook to GHL
  if (action === "BOOK" || action === "CALLBACK" || action === "END") {
    await postToGHLInboundWebhookSafe({
      intent: action,
      source: "AI_CALL",
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      phone: state.leadPhone,
      first_name: state.leadName,
      email: state.leadEmail,
      address: state.address,
      postcode: state.postcode,
      homeowner: state.homeowner,
      preferred_window: fields.preferred_window || "",
      notes: fields.notes || "",
      confirm_address: fields.confirm_address || "",
      transcript: compactTranscript(state.history, AGENT_NAME),
      callSid
    });

    // Natural close
    const close =
      action === "BOOK"
        ? `${reply} Perfect — I’ll get that booked and text you the details now. Bye for now.`
        : action === "CALLBACK"
          ? `${reply} No problem — I’ll arrange a callback. Bye for now.`
          : `${reply} Thanks for your time — bye for now.`;

    return res.type("text/xml").send(makeTwiMLPlayAndHangup(close));
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

// ------------------ Twilio call status callback ------------------
app.post("/twilio/status", (req, res) => {
  console.log("Call status:", {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    To: req.body.To,
    From: req.body.From,
    Duration: req.body.CallDuration
  });

  if (req.body.CallStatus === "completed") {
    callState.delete(req.body.CallSid);
  }

  res.status(200).send("ok");
});

// ------------------ OpenAI helper ------------------
async function getNextFromOpenAI(history) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.5,
      messages: history
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
    parsed = { reply: content.slice(0, 220), action: "CONTINUE", fields: {} };
  }

  const reply = (parsed.reply || "").toString().trim();
  const actionRaw = (parsed.action || "CONTINUE").toString().toUpperCase();
  const action = ["CONTINUE", "BOOK", "CALLBACK", "END"].includes(actionRaw) ? actionRaw : "CONTINUE";

  return { reply, action, fields: parsed.fields || {} };
}

// ------------------ Post to GHL inbound webhook ------------------
async function postToGHLInboundWebhookSafe(payload) {
  try {
    if (!GHL_INBOUND_WEBHOOK_URL) {
      console.log("No GHL_INBOUND_WEBHOOK_URL set. Payload (not sent):", payload.intent);
      return;
    }
    await fetch(GHL_INBOUND_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("GHL inbound webhook failed:", e);
  }
}

function compactTranscript(history, agentName) {
  return history
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => `${m.role === "user" ? "Lead" : agentName}: ${m.content}`)
    .join("\n");
}

function makeTwiMLPlayAndHangup(text) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(text)}</Play>
  <Hangup/>
</Response>`;
}

// ------------------ Listen ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
