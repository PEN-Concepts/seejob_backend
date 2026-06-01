const express = require("express");
const router = express.Router();
const pool = require('../config/connection');
const logger = require("../common/logger");
const { getCurrentDateTime, getTimeStamp } = require("../common/timdate");


router.get("/getcategory", async (req, res) => {
    let connection;

    try {
        connection = await pool.getConnection();

        query = "SELECT * FROM category where id <> 1 order by id Desc";
        const [rows] = await connection.query(query);
        res.status(200).json({ code: "200", message: "getcategory data successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});


router.get("/getsubcategory/:id", async (req, res) => {
    const category = req.params.id
    let connection;
    try {
        connection = await pool.getConnection();

        query = "SELECT id, name FROM subcategory where category_id = ? order by id asc";
        const [rows] = await connection.query(query, [category]);
        res.status(200).json({ code: "200", message: "getsubcategory data by category successfully", data: rows });
        return;
    } catch (error) {
        logger.error(`${error}`)
        res.status(200).json({ code: "500", data: {}, message: "Something went wrong" });
        return;
    } finally {
        if (connection) connection.release();
    }

});


module.exports = router;
