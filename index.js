const express = require("express");

const app = express();

// Twilio sends form-encoded by default, so handle both:
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Twilio Voice Webhook (POST)
app.post("/twilio/voice", (req, res) => {
  // Return TwiML
  res
    .status(200)
    .type("text/xml")
    .send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello from Railway. Your webhook is working.</Say>
</Response>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
