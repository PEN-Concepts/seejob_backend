require('dotenv').config();
const mysql = require('mysql2/promise');

let pool;

if (process.env.NODE_ENV === 'production') {
    pool = mysql.createPool({
        host: process.env.DB_HOST_PROD,
        user: process.env.DB_USER_PROD,
        password: process.env.DB_PASSWORD_PROD,
        database: process.env.DB_NAME_PROD,
        port: process.env.DB_PORT_PROD,
        waitForConnections: true,
        connectionLimit: 100,
        // Bound the wait queue so a future pool exhaustion FAILS FAST with a
        // clear "Queue limit reached" error instead of hanging requests forever.
        queueLimit: 50,
        connectTimeout: 10000, // 10s to establish a connection (was 5 min)
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        timezone: 'local',
        dateStrings: true
    });
} else {
    pool = mysql.createPool({
        host: process.env.DB_HOST_DEV,
        user: process.env.DB_USER_DEV,
        password: process.env.DB_PASSWORD_DEV,
        database: process.env.DB_NAME_DEV,
        port: process.env.DB_PORT_DEV,
        waitForConnections: true,
        connectionLimit: 100,
        // Bound the wait queue so a future pool exhaustion FAILS FAST with a
        // clear "Queue limit reached" error instead of hanging requests forever.
        queueLimit: 50,
        connectTimeout: 10000, // 10s to establish a connection (was 5 min)
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
         timezone: 'local',
       dateStrings: true
    });
}

module.exports = pool;