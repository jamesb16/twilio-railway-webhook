/**
 * Greenbug Energy - Outbound AI Caller (Nicola) + GHL Booking Webhook
 *
 * Required env vars:
 *  PUBLIC_BASE_URL            = https://twilio-railway-webhook-production.up.railway.app
 *  TWILIO_ACCOUNT_SID         = ACxxxx
 *  TWILIO_AUTH_TOKEN          = xxxxx
 *  TWILIO_FROM_NUMBER         = +44....
 *  OPENAI_API_KEY             = sk-...
 *  ELEVENLABS_API_KEY         = xxxxx
 *  ELEVENLABS_VOICE_ID        = Flx6Swjd7o5h8giaG5Qk
 *
 * For booking trigger (GHL Inbound Webhook URL):
 *  GHL_BOOKING_TRIGGER_URL    = https://services.leadconnectorhq.com/hooks/.... (from GHL trigger)
 *
 * Optional:
 *  AGENT_NAME                 = Nicola
 *  COMPANY_NAME               = Greenbug Energy
 *  MAX_TURNS                  = 8
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
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  GHL_BOOKING_TRIGGER_URL,
} = process.env;

const AGENT_NAME = process.env.AGENT_NAME || "Nicola";
const COMPANY_NAME = process.env.COMPANY_NAME || "Greenbug Energy";
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "8", 10);

// In-memory state (fine for now)
const callState = new Map(); // CallSid -> { turns, history, leadName, leadPhone, leadEmail, leadAddress, leadPostcode, propertyType, homeowner }

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

// ------------------ TEST: send sample payload to GHL inbound webhook ------------------
// Open in browser:  https://YOUR_PUBLIC_URL/send-test-to-ghl
app.get("/send-test-to-ghl", async (req, res) => {
  return sendTestToGhl(req, res);
});
app.post("/send-test-to-ghl", async (req, res) => {
  return sendTestToGhl(req, res);
});

async function sendTestToGhl(req, res) {
  try {
    if (!GHL_BOOKING_TRIGGER_URL) {
      return res.status(400).json({ ok: false, error: "Missing GHL_BOOKING_TRIGGER_URL env var" });
    }

    // Example payload that matches your form fields (Solar survey)
    const payload = {
      event: "AI_BOOKING_TEST",
      intent: "BOOK",
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      contact: {
        fullName: "Test Lead",
        phone: "+447700900123",
        email: "testlead@example.com",
      },
      address: {
        street: "1 Test Street",
        city: "Glasgow",
        postcode: "G1 1AA",
      },
      property: {
        propertyType: "House",
        homeowner: true,
      },
      notes: "This is a test payload to create Mapping Reference in GHL.",
      preferred: {
        day: "Next week",
        timeWindow: "Afternoon",
      },
      timestamp: new Date().toISOString(),
    };

    const r = await fetch(GHL_BOOKING_TRIGGER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const txt = await r.text();
    return res.status(200).json({ ok: true, sentTo: "GHL Inbound Webhook", status: r.status, response: txt });
  } catch (e) {
    console.error("send-test-to-ghl error:", e);
    return res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
}

// ------------------ Outbound call trigger from GHL (new lead) ------------------
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

    // Optional fields from your form (if GHL sends them through)
    const leadEmail = body.email || body.Email || body.contact?.email || "";
    const street = body.address || body.street || body.streetAddress || body.contact?.address1 || "";
    const city = body.city || body.town || body.contact?.city || "";
    const postcode = body.postalCode || body.postcode || body.post_code || body.contact?.postalCode || "";
    const propertyType = body.propertyType || body.property_type || "";
    const homeowner = body.homeowner ?? body.areYouTheHomeowner ?? body.isHomeowner ?? "";

    if (!phoneRaw) return res.status(400).json({ ok: false, error: "Missing phone in payload" });

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
      return res.status(500).json({ ok: false, error: "Missing Twilio env vars" });
    }
    if (!PUBLIC_BASE_URL) {
      return res.status(500).json({ ok: false, error: "Missing PUBLIC_BASE_URL" });
    }

    const to = String(phoneRaw).trim();
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
      to,
      from: TWILIO_FROM_NUMBER,
      url: `${PUBLIC_BASE_URL}/twilio/voice?leadName=${encodeURIComponent(leadName)}&leadPhone=${encodeURIComponent(to)}&leadEmail=${encodeURIComponent(leadEmail)}&street=${encodeURIComponent(street)}&city=${encodeURIComponent(city)}&postcode=${encodeURIComponent(postcode)}&propertyType=${encodeURIComponent(propertyType)}&homeowner=${encodeURIComponent(String(homeowner))}`,
      method: "POST",
      statusCallback: `${PUBLIC_BASE_URL}/twilio/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    return res.status(200).json({
      ok: true,
      message: "Call triggered",
      sid: call.sid,
      to,
      leadName,
    });
  } catch (e) {
    console.error("Error in /ghl/lead:", e);
    return res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
});

// ------------------ Twilio: start call ------------------
app.post("/twilio/voice", (req, res) => {
  const leadName = (req.query.leadName || "there").toString();
  const leadPhone = (req.query.leadPhone || "").toString();

  const leadEmail = (req.query.leadEmail || "").toString();
  const street = (req.query.street || "").toString();
  const city = (req.query.city || "").toString();
  const postcode = (req.query.postcode || "").toString();
  const propertyType = (req.query.propertyType || "").toString();
  const homeowner = (req.query.homeowner || "").toString();

  const callSid = (req.body.CallSid || req.query.CallSid || "").toString();

  if (!callState.has(callSid)) {
    callState.set(callSid, {
      turns: 0,
      leadName,
      leadPhone,
      leadEmail,
      leadAddress: street,
      leadCity: city,
      leadPostcode: postcode,
      propertyType,
      homeowner,
      history: [
        {
          role: "system",
          content:
            `You are ${AGENT_NAME}, calling from ${COMPANY_NAME} (UK). ` +
            `You are calling a lead about SOLAR PANELS / a free home energy survey. ` +
            `They just filled out a form and requested a call back. ` +
            `Goal: confirm key details (address/postcode), ask 3-5 quick qualifying questions, answer common questions naturally, and book the survey. ` +
            `Be human, warm, not salesy, not robotic. Never say you are AI. ` +
            `Keep answers short. Ask one question at a time.\n\n` +
            `What we already have from the form (may be blank):\n` +
            `Name: ${leadName}\nPhone: ${leadPhone}\nEmail: ${leadEmail}\nStreet: ${street}\nCity: ${city}\nPostcode: ${postcode}\nProperty type: ${propertyType}\nHomeowner: ${homeowner}\n\n` +
            `BOOK when they agree and you have: postcode + a preferred day/time window.`
        },
      ],
    });
  }

  const firstLine =
    `Hi ${leadName}, it’s ${AGENT_NAME} from ${COMPANY_NAME}. ` +
    `You popped your details in about solar panels and a free home energy survey. ` +
    `Have I caught you at an okay time for a quick minute?`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(firstLine)}</Play>
  <Gather input="speech" action="/twilio/turn?CallSid=${encodeURIComponent(callSid)}" method="POST" speechTimeout="auto" />
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent("No worries — I’ll send you a text so you can pick a better time. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ------------------ Twilio: conversation turn ------------------
app.post("/twilio/turn", async (req, res) => {
  const callSid = (req.query.CallSid || req.body.CallSid || "").toString();
  const speech = (req.body.SpeechResult || "").toString().trim();
  const confidence = req.body.Confidence;

  const state = callState.get(callSid);
  if (!state) {
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("Sorry — something went wrong. Bye for now."));
  }

  state.turns += 1;
  console.log("TURN", { callSid, turn: state.turns, speech, confidence });

  if (!speech) {
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("No worries — I’ll text you a link to pick a time. Bye for now."));
  }
  if (state.turns >= MAX_TURNS) {
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("Thanks — I won’t keep you. I’ll text you the next steps. Bye for now."));
  }

  state.history.push({ role: "user", content: speech });

  let ai;
  try {
    ai = await getNextFromOpenAI(state.history);
  } catch (e) {
    console.error("OpenAI error:", e);
    return res.type("text/xml").send(makeTwiMLPlayAndHangup("Sorry — quick technical issue. I’ll text you shortly to arrange the survey. Bye for now."));
  }

  const { reply, action, booking } = ai;
  state.history.push({ role: "assistant", content: reply });
  callState.set(callSid, state);

  if (action === "BOOK") {
    // Send booking intent to GHL inbound webhook trigger
    await postBookingToGHL({
      intent: "BOOK",
      agent: AGENT_NAME,
      company: COMPANY_NAME,
      callSid,
      lead: {
        fullName: state.leadName,
        phone: state.leadPhone,
        email: state.leadEmail,
      },
      address: {
        street: state.leadAddress || "",
        city: state.leadCity || "",
        postcode: (booking?.postcode || state.leadPostcode || "").toString(),
      },
      preferred: {
        day: booking?.preferred_day || "",
        timeWindow: booking?.time_window || "",
      },
      notes: booking?.notes || "",
      transcript: compactTranscript(state.history, AGENT_NAME),
      timestamp: new Date().toISOString(),
    });

    const closing = `${reply} Perfect — I’ll get that booked in now and text you the details. Bye for now.`;
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(closing));
  }

  if (action === "END") {
    return res.type("text/xml").send(makeTwiMLPlayAndHangup(reply));
  }

  // Continue
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent(reply)}</Play>
  <Gather input="speech" action="/twilio/turn?CallSid=${encodeURIComponent(callSid)}" method="POST" speechTimeout="auto" />
  <Play>${PUBLIC_BASE_URL}/tts?text=${encodeURIComponent("Sorry, I didn’t catch that. I’ll text you so we can sort a time. Bye for now.")}</Play>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ------------------ Twilio status callback ------------------
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

  if (payload.CallStatus === "completed") {
    callState.delete(payload.CallSid);
  }
  res.status(200).send("ok");
});

// ------------------ Post to GHL booking webhook ------------------
async function postBookingToGHL(payload) {
  try {
    if (!GHL_BOOKING_TRIGGER_URL) {
      console.warn("Missing GHL_BOOKING_TRIGGER_URL - booking not sent");
      return;
    }
    const r = await fetch(GHL_BOOKING_TRIGGER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    console.log("Posted booking to GHL:", r.status, txt);
  } catch (e) {
    console.error("postBookingToGHL failed:", e);
  }
}

// ------------------ OpenAI helper ------------------
async function getNextFromOpenAI(history) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const messages = [
    ...history,
    {
      role: "system",
      content:
        `Return ONLY valid JSON: {"reply":"...","action":"CONTINUE|BOOK|END","booking":{"postcode":"","preferred_day":"","time_window":"","notes":""}}.\n` +
        `Rules:\n` +
        `- CONTINUE = normal conversation.\n` +
        `- BOOK only when they agree to book AND you have at least postcode + preferred day/time window.\n` +
        `- END if wrong number / not interested / hostile.\n` +
        `Tone: UK, warm, human, not salesy, short sentences. Ask ONE question at a time.\n` +
        `Solar survey qualifying questions you can use:\n` +
        `1) Are you the homeowner?\n` +
        `2) Is it a house or flat?\n` +
        `3) Roughly how much is your monthly electricity bill?\n` +
        `4) Do you know if your roof is pitched and mostly unshaded?\n` +
        `5) Any idea if you’d want battery storage as well, or just panels?\n` +
        `If address/postcode already present, just confirm it.\n`
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
    parsed = { reply: content.slice(0, 220), action: "CONTINUE", booking: {} };
  }

  const reply = (parsed.reply || "").toString().trim() || "Okay — tell me a bit more about that.";
  const actionRaw = (parsed.action || "CONTINUE").toString().toUpperCase();
  const action = ["CONTINUE", "BOOK", "END"].includes(actionRaw) ? actionRaw : "CONTINUE";
  const booking = parsed.booking || {};

  return { reply, action, booking };
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

// IMPORTANT: Railway port
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
