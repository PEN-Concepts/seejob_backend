const winston = require("winston");
const path = require("path");
const DailyRotateFile = require("winston-daily-rotate-file");

const transport = new DailyRotateFile({
  filename: "logs-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  zippedArchive: true,
  maxSize: "20m",
  maxFiles: "30d",
  dirname: path.join(__dirname, "../logs"), // Use absolute path
});

var logger = winston.createLogger({
  transports: [
    transport,
    // Add other transports if needed
  ],
});

module.exports = logger;