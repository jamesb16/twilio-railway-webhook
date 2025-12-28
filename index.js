// -------------------- Twilio: handle speech + continue conversation --------------------
app.post("/twilio/speech", async (req, res) => {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence;

  const session = sessions.get(callSid) || { lead: {}, transcript: [], turns: 0, stage: "OPEN" };
  session.turns = (session.turns || 0) + 1;

  if (speech) session.transcript.push({ role: "user", text: speech });

  console.log("Speech:", { callSid, speech, confidence, stage: session.stage });

  // Safety stop: don’t loop forever
  if (session.turns >= 12) {
    const bye = "Thanks — my system’s being a bit slow right now. I’ll send you a text so you can pick a time that suits. Bye for now.";
    const twimlEnd = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(bye)}</Play>
  <Hangup/>
</Response>`;
    sessions.set(callSid, session);
    return res.type("text/xml").send(twimlEnd);
  }

  // -------------------- Deterministic booking flow (prevents loops) --------------------
  // We already have address + postcode from the form. So:
  // 1) Confirm address/postcode
  // 2) Ask preferred day
  // 3) Ask morning/afternoon
  // 4) Finish + send webhook

  // Initialise stage after first user response to opening line
  if (session.stage === "OPEN") {
    // If they said "no/busy" early, exit nicely.
    if (isNo(speech) || /\b(busy|later|call me later|not a good time)\b/i.test(speech)) {
      const bye = "No worries at all — I’ll send you a text and you can pick a time that suits. Bye for now.";
      const twimlBye = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(bye)}</Play>
  <Hangup/>
</Response>`;
      sessions.set(callSid, session);
      return res.type("text/xml").send(twimlBye);
    }

    // Move straight to address confirm
    session.stage = "CONFIRM_ADDRESS";
    const addrLine = session.lead?.address ? `We’ve got your address as ${session.lead.address}` : "";
    const pcLine = session.lead?.postcode ? `and the postcode as ${session.lead.postcode}` : "";
    const q = `${pickFiller()} Just to confirm, ${[addrLine, pcLine].filter(Boolean).join(" ")} — is that correct?`;

    sessions.set(callSid, session);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(q)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — I didn’t catch that. Is the address and postcode correct?")}</Play>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  if (session.stage === "CONFIRM_ADDRESS") {
    if (isYes(speech)) {
      session.stage = "ASK_DAY";
      const q = `${pickFiller()} Perfect. Let’s get your free survey booked in — what day suits you best?`;

      sessions.set(callSid, session);

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(q)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — what day works best for you? For example Monday or Tuesday.")}</Play>
</Response>`;
      return res.type("text/xml").send(twiml);
    }

    if (isNo(speech)) {
      // Don’t loop forever: ask once for the correct postcode (simplest)
      session.stage = "CAPTURE_POSTCODE";
      const q = `${pickFiller()} No problem — what’s the correct postcode?`;

      sessions.set(callSid, session);

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(q)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — can you repeat the postcode?")}</Play>
</Response>`;
      return res.type("text/xml").send(twiml);
    }

    // If unclear, re-ask without changing stage
    const q = `Sorry — just to confirm, is the address and postcode correct?`;
    sessions.set(callSid, session);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(q)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — is it correct, yes or no?")}</Play>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  if (session.stage === "CAPTURE_POSTCODE") {
    // Save whatever they said as postcode to stop loops
    if (speech) session.lead.postcode = speech;
    session.stage = "ASK_DAY";

    const q = `${pickFiller()} Great. What day suits you best for the survey?`;

    sessions.set(callSid, session);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(q)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — what day works best for you?")}</Play>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  if (session.stage === "ASK_DAY") {
    const day = extractDay(speech);
    if (day) {
      session.booking = session.booking || {};
      session.booking.preferred_day = day;
      session.stage = "ASK_WINDOW";

      const q = `${pickFiller()} Nice one. Would you prefer morning or afternoon?`;

      sessions.set(callSid, session);

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(q)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — morning or afternoon?")}</Play>
</Response>`;
      return res.type("text/xml").send(twiml);
    }

    // If no day detected, ask again (once)
    const q = "What day suits you best? For example Monday or Tuesday.";
    sessions.set(callSid, session);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(q)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — which day works best?")}</Play>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  if (session.stage === "ASK_WINDOW") {
    const win = extractWindow(speech);
    if (win) {
      session.booking = session.booking || {};
      session.booking.preferred_window = win;

      // Post booking to GHL now
      try {
        await postToGhlBookingWebhook({
          lead: session.lead,
          booking: session.booking,
          transcript: session.transcript
        });
      } catch (e) {
        console.error("GHL webhook post failed:", e?.message || e);
      }

      const done = `Perfect. I’ll send you a text or email to confirm. If you need to cancel or change it, just reply to the message. Bye for now.`;

      sessions.set(callSid, session);

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(done)}</Play>
  <Hangup/>
</Response>`;
      return res.type("text/xml").send(twiml);
    }

    const q = "No problem — do you prefer morning or afternoon?";
    sessions.set(callSid, session);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(q)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — morning or afternoon?")}</Play>
</Response>`;
    return res.type("text/xml").send(twiml);
  }

  // -------------------- If we get here, fall back to your AI (rare) --------------------
  const ai = await getAiTurn({ lead: session.lead, transcript: session.transcript });
  session.transcript.push({ role: "assistant", text: ai.reply });
  sessions.set(callSid, session);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${baseUrl}/tts?text=${encodeURIComponent(ai.reply)}</Play>
  <Gather input="speech" language="en-GB" action="${baseUrl}/twilio/speech" method="POST" speechTimeout="auto" timeout="7"/>
  <Play>${baseUrl}/tts?text=${encodeURIComponent("Sorry — I didn’t catch that. Can you say that one more time?")}</Play>
</Response>`;
  return res.type("text/xml").send(twiml);
});
