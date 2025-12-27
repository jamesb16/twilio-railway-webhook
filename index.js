const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: false }));

app.get("/health", (req, res) => {
  res.send("ok");
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Twilio webhook working.</Say>
</Response>`);
});

// 🚨 THIS IS THE IMPORTANT PART
const port = process.env.PORT;

if (!port) {
  throw new Error("PORT environment variable not set");
}

app.listen(port, "0.0.0.0", () => {
  console.log("Listening on", port);
});
