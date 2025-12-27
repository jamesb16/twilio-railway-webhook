const express = require("express");

const app = express();

// Twilio sends form-encoded POST bodies by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Twilio Voice webhook
app.all("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-GB">
    Hello. Your Railway webhook is working.
  </Say>
</Response>`);
});

// IMPORTANT: listen on Railway's PORT
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
