require('./cron/nudgeReminder');
require('./cron/autoClockOut');
require('./cron/licenseCheck');
require('./cron/archiveTasks');
require('dotenv').config();
const express = require("express");
const cors = require("cors");
const pool = require('./config/connection');
const logger = require("./common/logger");
const { getCurrentDateTime } = require("./common/timdate")
const userRoute = require("./routes/users");
const contactRoute = require("./routes/contacts");
const publicRoute = require("./routes/publics");
const publicjobs = require("./routes/jobs");
const tasks = require("./routes/tasks");
const publicnotepad = require("./routes/notepads");
const path = require('path');
const leads = require("./routes/leads");
const publicinvitation = require("./routes/invitations");
const clockin = require("./routes/clockin");
const changeOrder = require("./routes/change_order");
const equipment = require("./routes/equipments");
const teaam = require("./routes/teams");
const time_card = require("./routes/time_card");
const quote = require("./routes/quote");
const safety = require("./routes/safety_course");
const supportTicket = require("./routes/support_ticket");
const pins = require("./routes/pins");
const notify = require("./routes/notifications");
const budget = require("./routes/budget");
const payments = require("./routes/payments");
const checklists = require("./routes/checklists");
const adminContact = require("./routes/admin_contactRequest");
const cookieParser = require("cookie-parser");
const calendar = require("./routes/calendar");
const spartan = require("./routes/spartan");
const translate = require("./routes/translate");
const bids = require("./routes/bids");
const app = express();
const api = process.env.API_URL;

const corsOriginsEnv = (process.env.CORS_ORIGINS || "").trim();
const allowedOrigins = corsOriginsEnv
  ? corsOriginsEnv.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const corsOptions = {
  origin: (origin, cb) => {
    // Allow non-browser clients (no Origin header) like Postman/mobile native
    if (!origin) return cb(null, true);

    // In dev (or if no whitelist configured), allow all origins
    if (process.env.NODE_ENV !== 'production' || allowedOrigins.length === 0) {
      return cb(null, true);
    }

    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.urlencoded({ extended: true }));
//app.use(cookieParser());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf && buf.length ? buf.toString("utf8") : "";
    },
  })
);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Global request logger for all APIs
app.use((req, res, next) => {
  const userId = (req.user && req.user.id) || res.locals.id || 'anonymous';
  logger.info(
    `API: ${req.method} ${req.originalUrl} user=${userId} - ${new Date()}`
  );
  next();
});
app.use(cookieParser());


app.use(`${api}/user`, userRoute);
app.use(`${api}/contact`, contactRoute);
app.use(`${api}/public`, publicRoute);
app.use(`${api}/jobs`, publicjobs);
app.use(`${api}/notepads`, publicnotepad);
app.use(`${api}/invitations`, publicinvitation);
app.use(`${api}/change_order`, changeOrder);
app.use(`${api}/equipment`, equipment);
app.use(`${api}/teams`, teaam);
app.use(`${api}/time_card`, time_card);
app.use(`${api}/quote`, quote);
app.use(`${api}/safety_course`, safety);
app.use(`${api}/tasks`, tasks);
app.use(`${api}/leads`, leads);
app.use(`${api}/support_ticket`, supportTicket);
app.use(`${api}/pins`, pins);
app.use(`${api}/notifications`, notify);
app.use(`${api}/clockin`, clockin);
app.use(`${api}/budget`, budget);
app.use(`${api}/payments`, payments);
app.use(`${api}/checklists`, checklists);
app.use(`${api}/admin_contactRequest`, adminContact);
app.use(`${api}/calendar`, calendar);
app.use(`${api}/spartan`, spartan);
app.use(`${api}/translate`, translate);
app.use(`${api}/bids`, bids);


// Global error handler to log unexpected exceptions
app.use((err, req, res, next) => {
  const userId = (req.user && req.user.id) || res.locals.id || 'anonymous';
  logger.error(
    `API ERROR: ${req.method} ${req.originalUrl} user=${userId} - ${new Date()} - ${err && err.message}`,
    err
  );

  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ message: 'Server error' });
});

app.get('/checkdb', async (req, res) => {
    const currentTime = getCurrentDateTime();
    try {
        const [rows, fields] = await pool.query('SELECT 1');
        logger.info(`Get Hit on /checkdb - ${currentTime}`);
        res.status(200).json({ message: 'Database connection is active.' });
    } catch (error) {
        logger.error('Error checking database connection:', error);
        res.status(500).json({ error: 'Database connection is not available.' });
    }
});

// Function to check the database connection
const checkDatabaseConnection = async () => {
    try {
        const [rows, fields] = await pool.query('SELECT 1');
        logger.info('Database connected with ' + process.env.NODE_ENV);
        return true;
    } catch (error) {
        logger.error('Error connecting to the database:', error);
        return false;
    }
};

// Function to start the server with retry logic for database connection
const startServer = async (retries = 5, delay = 5000) => {
    while (retries > 0) {
        const dbConnected = await checkDatabaseConnection();
        if (dbConnected) {
            const port = process.env.PORT || 3000;
            app.listen(port, () => logger.info(`Listening on port ${port}`));
            return;
        } else {
            logger.warn(`Retrying to connect to the database... (${retries - 1} retries left)`);
            retries--;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    logger.error('Failed to connect to the database after multiple attempts.');
    process.exit(1); // Exit the application if unable to connect to the database
};

// Start the server
startServer();