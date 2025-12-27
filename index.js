const express = require("express");

const app = express();

// Twilio sends webhooks as x-www-form-urlencoded by default:
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Twilio Voice webhook
app.post("/twilio/voice", (req, res) => {
  // Return TwiML (XML) that speaks then hangs up
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-GB">Hello. Your Twilio webhook is working on Railway. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

// Railway sets PORT. Default to 3000 locally.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
