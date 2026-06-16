const express = require("express");
const router = express.Router();
const pool = require('../config/connection');
const Joi = require("joi");
const logger = require("../common/logger");
const { addUserSchema } = require("../models/user");
const auth = require("../services/authentication");
const { denyExpiredFreeWrites, getAccessMode } = require("../utils/access");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");
const { contactSchema } = require("../models/contact");


router.get("/search/:key", auth.authenticateToken, async (req, res) => {
    const key = req.params.key;
    const searchKey = `%${key}%`;
    let connection;
    try {
        connection = await pool.getConnection();
        const query = `
            SELECT u.id, u.name, u.email, u.mobile
            FROM user u
            WHERE u.name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ?
        `;
        const [rows] = await connection.query(query, [searchKey, searchKey, searchKey]);
        res.status(200).json({ code: "200", message: "Search contact successfully", data: rows });
    } catch (error) {
        logger.error("Search contact error:", error);
        res.status(500).json({ code: "500", message: "Internal Server Error" });
    } finally {
        if (connection) connection.release();
    }
});


router.get("/getuserbycategory/:id", auth.authenticateToken, async (req, res) => {
    const id = req.params.id;
    let connection;
    try {
        connection = await pool.getConnection();
        query = "SELECT u.id, u.name, u.email, u.mobile FROM user u where u.category = ? order by u.id asc";
        const [rows] = await connection.query(query, [id]);
        res.status(200).json({ code: "200", message: "getuserbycategory data successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});


router.get("/getuserbysubcategory/:id", auth.authenticateToken, async (req, res) => {
    const id = req.params.id;
    let connection;
    try {
        connection = await pool.getConnection();
        query = "SELECT u.id, u.name, u.email, u.mobile FROM user u where u.subcategory = ? order by u.id asc";
        const [rows] = await connection.query(query, [id]);
        res.status(200).json({ code: "200", message: "getuserbysubcategory data successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});

router.get("/mycontactrequest", auth.authenticateToken, async (req, res) => {
    const signedin_user = res.locals.working_id;
    let connection;

    try {
        connection = await pool.getConnection();
        // Expired free trial: contacts are hidden (saved, visible again on upgrade).
        if ((await getAccessMode(req.user.id, connection)) === 'expired_free') {
            res.status(200).json({ code: "200", message: "mycontactrequest data successfully", data: [] });
            return;
        }
        query = "SELECT u.id, u.name, u.email, u.mobile, c.status FROM user u join contact c on (c.request_to = u.id) where c.request_by = ? order by u.id asc";
        const [rows] = await connection.query(query, [signedin_user]);
        res.status(200).json({ code: "200", message: "mycontactrequest data successfully", data: rows });
        return;
    } catch (error) {

        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    }
    finally {
        if (connection) connection.release();
    }

});


router.get("/mypendingcontactrequest", auth.authenticateToken, async (req, res) => {
    const signedin_user = res.locals.working_id;
    let connection;

    try {
        connection = await pool.getConnection();
        // Expired free trial: contacts are hidden (saved, visible again on upgrade).
        if ((await getAccessMode(req.user.id, connection)) === 'expired_free') {
            res.status(200).json({ code: "200", message: "mypendingcontactrequest data successfully", data: [] });
            return;
        }
        query = "SELECT c.id as requestid, u.id, u.name, u.email, u.mobile, c.status FROM user u join contact c on (c.request_by = u.id) where c.request_to = ? order by u.id asc";
        const [rows] = await connection.query(query, [signedin_user]);
        res.status(200).json({ code: "200", message: "mypendingcontactrequest data successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});

router.get("/mycontact", auth.authenticateToken, async (req, res) => {
    const signedin_user = res.locals.working_id;
    let connection;

    try {
        connection = await pool.getConnection();
        // Expired free trial: contacts are hidden (saved, visible again on upgrade).
        if ((await getAccessMode(req.user.id, connection)) === 'expired_free') {
            res.status(200).json({ code: "200", message: "mycontact data successfully", data: [] });
            return;
        }
        query = "SELECT u.id, u.name, u.email, u.mobile, c.status FROM user u join contact c on (c.request_to = u.id) where c.request_by = ? and c.status = 'Accept' order by u.id asc";
        const [rows] = await connection.query(query, [signedin_user]);
        res.status(200).json({ code: "200", message: "mycontact data successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});

router.get("/mycontact/:subcategory", auth.authenticateToken, async (req, res) => {
    const signedin_user = res.locals.working_id;
    const subcategory = req.params.subcategory
    let connection;

    try {
        connection = await pool.getConnection();
        // Expired free trial: contacts are hidden (saved, visible again on upgrade).
        if ((await getAccessMode(req.user.id, connection)) === 'expired_free') {
            res.status(200).json({ code: "200", message: "mycontact by subcategory data successfully", data: [] });
            return;
        }
        query = "SELECT u.id, u.name, u.email, u.mobile, c.status FROM user u join contact c on (c.request_to = u.id) where c.request_by = ? and c.status = 'Accept' and u.subcategory = ? order by u.id asc";
        const [rows] = await connection.query(query, [signedin_user, subcategory]);
        res.status(200).json({ code: "200", message: "mycontact by subcategory data successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});

router.post("/statuschange/:id/:status", auth.authenticateToken, denyExpiredFreeWrites, async (req, res) => {
    const reqid = req.params.id
    const status = req.params.status

    if (status == 'accept' || status == 'reject') {

        const signedin_user = res.locals.working_id;
        const currentTimestamp = getTimeStamp();

        let connection;
        try {
            connection = await pool.getConnection();


            if (status == 'accept') {
                const checkquery = "SELECT u.contact_available, u.id, u.name FROM user u join contact c on (c.request_by = u.id) where c.id = ?"
                const [checkqueryresult] = await connection.query(checkquery, [
                    reqid,
                ]);

                if (checkqueryresult.length > 0) {

                    if (checkqueryresult[0].contact_available > 0) {

                        updateQuery1 =
                            "UPDATE `contact` SET `status` = ?, `updated_at` = ? WHERE (`id` = ?)"

                        const [result1] = await connection.query(updateQuery1, [
                            status,
                            currentTimestamp,
                            reqid
                        ]);
                        updateQuery2 =
                            "UPDATE `user` SET `contact_available` = ? WHERE (`id` = ?)";


                        const [result2] = await connection.query(updateQuery2, [
                            Number(checkqueryresult[0].contact_available) - 1,
                            reqid
                        ]);

                        logger.info("Contact status change successfully");
                        res.status(200).json({ code: "200", message: "Contact status change successfully", data: {} });
                        return
                    } else {
                        logger.error(`Create Contact request error is: Please asks ${checkqueryresult[0].name} to buy contacts `);
                        res.status(200).json({ code: "400", message: `Please asks ${checkqueryresult[0].name} to buy contacts`, data: {} });
                        return;
                    }
                } else {

                    updateQuery =
                        "UPDATE `contact` SET `status` = ?, `updated_at` = ? WHERE (`id` = ?)"

                    const [result] = await connection.query(updateQuery, [
                        status,
                        currentTimestamp,
                        reqid
                    ]);
                    logger.info("Contact status change successfully");
                    res.status(200).json({ code: "200", message: "Contact status change successfully", data: { result } });
                    return
                }

            } else {
                logger.error("Error change status contact request: ", error);
                res.status(200).json({ code: "500", message: "Internal server error", data: {} });
                return
            }


        } catch (error) {

            logger.error("Error change status contact request: ", error);
            res.status(200).json({ code: "500", message: "Internal server error", data: {} });
            return

        } finally {
            if (connection) connection.release();
        }
    } else {
        logger.error("Error change status contact request: invalid status");
        res.status(200).json({ code: "500", message: "Invalid Status", data: {} });
        return
    }


});


router.post("/create", auth.authenticateToken, denyExpiredFreeWrites, async (req, res) => {
    const signedin_user = res.locals.working_id;
    const currentTimestamp = getTimeStamp();
    const result = contactSchema(req.body);
    if (result.error) {
        res.status(200).json({ code: "400", message: result.error.details[0].message, data: {} });
        return;
    }
    const r = req.body;
    let connection;
    try {

        connection = await pool.getConnection();

        const checkquery = "SELECT contact_available FROM user where id = ?"
        const [checkqueryresult] = await connection.query(checkquery, [
            signedin_user,
        ]);

        if (checkqueryresult.length > 0) {

            if (checkqueryresult[0].contact_available > 0) {
                const query =
                    "INSERT INTO `contact` (`request_by`, `request_to`, `created_at`) VALUES (?, ?, ?)";
                const [result] = await connection.query(query, [
                    signedin_user,
                    r.request_to,
                    currentTimestamp,
                ]);
                logger.info("Contact request added successfully");
                res.status(200).json({ code: "200", message: "Contact request added successfully", data: {} });
                return
            } else {
                logger.error("Create Contact request error is: please buy contacts ");
                res.status(200).json({ code: "400", message: "Please buy contacts", data: {} });
                return;
            }


        } else {
            logger.error("Error contact request: ", error);
            res.status(200).json({ code: "500", message: "Internal server error", data: {} });
            return
        }


    } catch (error) {

        if (error.code == "ER_DUP_ENTRY") {
            logger.error("Create Contact request error is:", error);
            res.status(200).json({ code: "400", message: "Contact request already exists. ", data: {} });
            return;
        } else {
            logger.error("Error contact request: ", error);
            res.status(200).json({ code: "500", message: "Internal server error", data: {} });
            return
        }
    } finally {
        if (connection) connection.release();
    }

});




module.exports = router;

