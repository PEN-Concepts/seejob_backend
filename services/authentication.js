require("dotenv").config();

const jwt = require("jsonwebtoken");

function authenticateToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (token == null) return res.status(401).json({ message: "Access denied. No token provided." });

    jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
        if (err) {
            return res.status(403).json({ message: "Invalid or expired token." });
        }


        req.user = decoded; // ✅ Store user info in req.user
         res.locals.id = decoded.id;
           next();

    });
}

module.exports = { authenticateToken }
