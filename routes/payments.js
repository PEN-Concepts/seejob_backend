const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { authenticateToken } = require("../services/authentication");
const pool = require("../config/connection");
const logger = require("../common/logger");

// Authorize.Net SDK
const { APIControllers, APIContracts } = require("authorizenet");

// Environment helpers
const API_LOGIN_ID = process.env.AUTHORIZE_API_LOGIN_ID;
const TRANSACTION_KEY = process.env.AUTHORIZE_TRANSACTION_KEY;
const AUTHORIZE_ENV = process.env.AUTHORIZE_ENV || "sandbox"; // "sandbox" or "production"

function getApiEnvironment() {

  if (AUTHORIZE_ENV === "production") {
    // Live Authorize.Net XML endpoint
    return "https://api2.authorize.net/xml/v1/request.api";
  }
  // Sandbox Authorize.Net XML endpoint
  return "https://apitest.authorize.net/xml/v1/request.api";
}

function getValidationMode() {
  return AUTHORIZE_ENV === "production"
    ? APIContracts.ValidationModeEnum.LIVEMODE
    : APIContracts.ValidationModeEnum.TESTMODE;
}

function normalizeFeatureKey(featureKey) {
  const key = String(featureKey || "").toLowerCase();
  if (key === "contacts") return "contact";
  if (key === "jobs") return "job";
  if (key === "my_daily_tasks") return "task";
  if (key === "task_manager") return "task";
  if (key === "checklist") return "checklist";
  if (key === "leads") return "lead";
  if (key === "appointments") return "appointment";
  if (key === "change_orders") return "changeorder";
  if (key === "equipment_management") return "equipment";
  if (key === "employee_management") return "user";
  if (key === "tailgate_safety_meetings") return "jobanalysis";
  if (key === "team_management") return "team";
  if (key === "daily_job_reports") return "dailysheet";
  if (key === "calendar") return "calendar";
  return key;
}

async function syncSubcontractorRole12Rights({ connection, userId, planId }) {
  const [userRows] = await connection.query(
    "SELECT id, role FROM user WHERE id = ? LIMIT 1",
    [userId]
  );

  if (!userRows.length || Number(userRows[0].role) !== 12) {
    return;
  }

  let featureSet = new Set();
  if (planId) {
    const [featureRows] = await connection.query(
      "SELECT feature_key FROM plan_features WHERE plan_id = ?",
      [planId]
    );
    const normalized = (Array.isArray(featureRows) ? featureRows : [])
      .map((row) => normalizeFeatureKey(row.feature_key))
      .filter(Boolean);
    featureSet = new Set(normalized);
  }

  const permissionsFor = (moduleName) => {
    const name = String(moduleName || "").toLowerCase();

    if (featureSet.has(name)) {
      return { read: "yes", create: "yes", update: "yes", delete: "yes" };
    }

    // Baseline for role 12 when not subscribed OR module not in the plan:
    // read=yes; create/update/delete=no
    // Exceptions needed for core flows.
    if (name === "subscription") {
      return { read: "yes", create: "yes", update: "yes", delete: "no" };
    }

    if (name === "invitation") {
      return { read: "yes", create: "no", update: "yes", delete: "no" };
    }

    if (name === "support") {
      return { read: "yes", create: "yes", update: "yes", delete: "no" };
    }

    return { read: "yes", create: "no", update: "no", delete: "no" };
  };

  const [rightsRows] = await connection.query(
    "SELECT id, name FROM `right` WHERE sub_heading = 0 ORDER BY id ASC"
  );

  const rights = Array.isArray(rightsRows) ? rightsRows : [];
  if (!rights.length) return;

  await connection.query(
    "DELETE FROM role_right_permission WHERE user_id = ?",
    [userId]
  );

  const values = rights.map((r) => {
    const perms = permissionsFor(r.name);
    return [12, userId, r.id, perms.read, perms.create, perms.update, perms.delete];
  });

  await connection.query(
    "INSERT INTO role_right_permission (role_id, user_id, right_id, `read`, `create`, `update`, `delete`) VALUES ?",
    [values]
  );
}

//  create and fetch an Authorize.Net customer profile and payment profile
async function createOrAddPaymentProfileForUser({ userId, email, opaqueData, billing, userName }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      "SELECT id, customer_profile_id FROM user_payment_methods WHERE user_id = ? LIMIT 1",
      [userId]
    );

    const existingRowId = rows.length > 0 ? rows[0].id : null;
    let customerProfileId;

    if (rows.length > 0 && rows[0].customer_profile_id) {
      customerProfileId = rows[0].customer_profile_id;
    }

    const merchantAuthentication = new APIContracts.MerchantAuthenticationType();
    merchantAuthentication.setName(API_LOGIN_ID);
    merchantAuthentication.setTransactionKey(TRANSACTION_KEY);

    const opaque = new APIContracts.OpaqueDataType();
    opaque.setDataDescriptor(opaqueData.dataDescriptor);
    opaque.setDataValue(opaqueData.dataValue);

    const paymentType = new APIContracts.PaymentType();
    paymentType.setOpaqueData(opaque);

    // Build Bill-To info with safe fallbacks so ARB always has first/last name
    const billTo = new APIContracts.CustomerAddressType();

    const safeUserName = (userName || "").trim();
    const nameParts = safeUserName ? safeUserName.split(/\s+/) : [];
    const fallbackFirst = nameParts[0] || "Customer";
    const fallbackLast = nameParts.slice(1).join(" ") || (nameParts[0] ? "" : "Name");

    const firstNameToUse = (billing && billing.firstName && String(billing.firstName).trim()) || fallbackFirst;
    const lastNameToUse = (billing && billing.lastName && String(billing.lastName).trim()) || fallbackLast;

    billTo.setFirstName(firstNameToUse);
    billTo.setLastName(lastNameToUse);

    if (billing && billing.zip) billTo.setZip(billing.zip);
    if (billing && billing.country) billTo.setCountry(billing.country);

    let createdCustomerProfileId = null;
    let createdPaymentProfileId = null;
    let cardBrand = null;
    let cardLast4 = null;

    if (!customerProfileId) {
      // Try to create a new customer profile. If Authorize.Net says a duplicate
      // customer profile already exists, reuse that profile id and just add a
      // payment profile instead of failing.
      try {
        const paymentProfile = new APIContracts.CustomerPaymentProfileType();
        paymentProfile.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL);
        paymentProfile.setPayment(paymentType);
        paymentProfile.setBillTo(billTo);

        const profile = new APIContracts.CustomerProfileType();
        if (email) profile.setEmail(email);
        profile.setMerchantCustomerId(String(userId));
        profile.setPaymentProfiles([paymentProfile]);

        const createRequest = new APIContracts.CreateCustomerProfileRequest();
        createRequest.setMerchantAuthentication(merchantAuthentication);
        createRequest.setProfile(profile);
        createRequest.setValidationMode(getValidationMode());

        const ctrl = new APIControllers.CreateCustomerProfileController(
          createRequest.getJSON()
        );
        ctrl.setEnvironment(getApiEnvironment());

        const result = await new Promise((resolve, reject) => {
          ctrl.execute(() => {
            const apiResponse = ctrl.getResponse();
            if (!apiResponse) {
              return reject(new Error("Empty response from Authorize.Net"));
            }
            const response = new APIContracts.CreateCustomerProfileResponse(apiResponse);
            if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
              resolve(response);
            } else {
              const msgObj = response.getMessages().getMessage()[0];
              const code = msgObj && msgObj.getCode ? msgObj.getCode() : null;
              const text = msgObj && msgObj.getText ? msgObj.getText() : "Unknown error";
              reject(
                new Error(
                  `Authorize.Net error${code ? ` [${code}]` : ""}: ${text}`
                )
              );
            }
          });
        });

        createdCustomerProfileId = result.getCustomerProfileId();
        const paymentProfileIds = result
          .getCustomerPaymentProfileIdList()
          .getNumericString();

        // Ensure we always store a simple string payment profile id
        createdPaymentProfileId = Array.isArray(paymentProfileIds)
          ? String(paymentProfileIds[0])
          : String(paymentProfileIds);

        customerProfileId = createdCustomerProfileId;
      } catch (e) {
        const msg = e && e.message ? String(e.message) : "";
        // Prefer code-based detection when present in the error string, fallback to message parsing.
        // Authorize.Net commonly returns E00039 for duplicate records.
        const hasDuplicateCode = msg.includes("[E00039]") || msg.includes("E00039");

        if (hasDuplicateCode || msg.includes("A duplicate record with ID")) {
          const match = msg.match(/ID (\d+) already exists/);
          if (match && match[1]) {
            customerProfileId = match[1];
          }
        } else {
          throw e;
        }
      }
    }

    // At this point, if customerProfileId is set but we do not yet have a
    // createdPaymentProfileId, create a payment profile under the existing
    // customer profile.
    if (customerProfileId && !createdPaymentProfileId) {
      const paymentProfile = new APIContracts.CustomerPaymentProfileType();
      paymentProfile.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL);
      paymentProfile.setPayment(paymentType);
      paymentProfile.setBillTo(billTo);

      const createPayProfReq = new APIContracts.CreateCustomerPaymentProfileRequest();
      createPayProfReq.setMerchantAuthentication(merchantAuthentication);
      createPayProfReq.setCustomerProfileId(customerProfileId);
      createPayProfReq.setPaymentProfile(paymentProfile);
      createPayProfReq.setValidationMode(getValidationMode());

      const ctrl = new APIControllers.CreateCustomerPaymentProfileController(
        createPayProfReq.getJSON()
      );
      ctrl.setEnvironment(getApiEnvironment());

      const result = await new Promise((resolve, reject) => {
        ctrl.execute(() => {
          const apiResponse = ctrl.getResponse();
          if (!apiResponse) {
            return reject(new Error("Empty response from Authorize.Net"));
          }
          const response = new APIContracts.CreateCustomerPaymentProfileResponse(apiResponse);
          if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
            resolve(response);
          } else {
            reject(
              new Error(
                "Authorize.Net error: " +
                  JSON.stringify(
                    response.getMessages().getMessage()[0].getText()
                  )
              )
            );
          }
        });
      });

      createdPaymentProfileId = String(result.getCustomerPaymentProfileId());
    }

    // After we know customerProfileId and createdPaymentProfileId,
    // fetch the payment profile details to get masked card number and brand
    try {
      const getReq = new APIContracts.GetCustomerPaymentProfileRequest();
      getReq.setMerchantAuthentication(merchantAuthentication);
      getReq.setCustomerProfileId(customerProfileId);
      getReq.setCustomerPaymentProfileId(createdPaymentProfileId);

      const getCtrl = new APIControllers.GetCustomerPaymentProfileController(
        getReq.getJSON()
      );
      getCtrl.setEnvironment(getApiEnvironment());

      const getResult = await new Promise((resolve, reject) => {
        getCtrl.execute(() => {
          const apiResponse = getCtrl.getResponse();
          if (!apiResponse) {
            return reject(new Error("Empty response from Authorize.Net (get profile)"));
          }
          const response = new APIContracts.GetCustomerPaymentProfileResponse(
            apiResponse
          );
          if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
            resolve(response);
          } else {
            reject(
              new Error(
                "Authorize.Net get profile error: " +
                  JSON.stringify(
                    response.getMessages().getMessage()[0].getText()
                  )
              )
            );
          }
        });
      });

      const paymentProfile = getResult.getPaymentProfile && getResult.getPaymentProfile();
      if (paymentProfile && paymentProfile.getPayment) {
        const payment = paymentProfile.getPayment();
        const cc = payment.getCreditCard && payment.getCreditCard();
        if (cc) {
          const maskedNumber = cc.getCardNumber && cc.getCardNumber(); // e.g. XXXX1111
          const cardType = cc.getCardType && cc.getCardType(); // e.g. Visa
          if (maskedNumber && typeof maskedNumber === "string") {
            cardLast4 = maskedNumber.slice(-4);
          }
          if (cardType && typeof cardType === "string") {
            cardBrand = cardType;
          }
        }
      }
    } catch (profileErr) {
      // If we can't fetch card brand/last4, continue without failing the whole flow
      logger.error("Failed to fetch Authorize.Net payment profile details: " + profileErr.message);
    }

    const isDefault = 1;

    await connection.query(
      "UPDATE user_payment_methods SET is_default = 0 WHERE user_id = ?",
      [userId]
    );

    // Strict one-card-per-user: update existing row if present, otherwise insert.
    let methodId = existingRowId;
    if (existingRowId) {
      await connection.query(
        "UPDATE user_payment_methods SET customer_profile_id = ?, payment_profile_id = ?, card_brand = ?, card_last4 = ?, is_default = ? WHERE id = ? AND user_id = ?",
        [
          customerProfileId,
          createdPaymentProfileId,
          cardBrand,
          cardLast4,
          isDefault,
          existingRowId,
          userId,
        ]
      );
    } else {
      const [insertResult] = await connection.query(
        "INSERT INTO user_payment_methods (user_id, customer_profile_id, payment_profile_id, card_brand, card_last4, is_default) VALUES (?, ?, ?, ?, ?, ?)",
        [
          userId,
          customerProfileId,
          createdPaymentProfileId,
          cardBrand,
          cardLast4,
          isDefault,
        ]
      );
      methodId = insertResult.insertId;
    }

    await connection.commit();

    return {
      id: methodId,
      customer_profile_id: customerProfileId,
      payment_profile_id: createdPaymentProfileId,
      card_brand: cardBrand,
      card_last4: cardLast4,
      is_default: !!isDefault,
    };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

router.post("/payment-method", authenticateToken, async (req, res) => {
  try {
    const userId = req.user && req.user.id ? req.user.id : res.locals.id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Strict one-card-per-user: this endpoint replaces the existing saved card.
    // Prevent duplicate submissions per user.
    const lockName = `payment_method_user_${userId}`;
    const [lockRows] = await pool.query("SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
    const lockAcquired = !!(lockRows && lockRows[0] && lockRows[0].acquired === 1);
    if (!lockAcquired) {
      return res.status(409).json({
        success: false,
        message: "A payment method update is already in progress. Please try again.",
      });
    }

    const { opaqueData, billing } = req.body || {};

    if (!opaqueData || !opaqueData.dataDescriptor || !opaqueData.dataValue) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment token.",
      });
    }

    if (!API_LOGIN_ID || !TRANSACTION_KEY) {
      logger.error("Authorize.Net credentials are not configured.");
      return res.status(500).json({
        success: false,
        message: "Payment configuration error.",
      });
    }

    const [userRows] = await pool.query(
      "SELECT email, name FROM user WHERE id = ? LIMIT 1",
      [userId]
    );

    const email = userRows.length > 0 ? userRows[0].email : null;
    const userName = userRows.length > 0 ? userRows[0].name : null;

    let paymentMethod;
    try {
      const [subRows] = await pool.query(
        "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
        [userId]
      );
      const hasActiveSubscription = subRows.length > 0;

      const [existingPmRows] = await pool.query(
        "SELECT id, customer_profile_id, payment_profile_id FROM user_payment_methods WHERE user_id = ? LIMIT 1",
        [userId]
      );

      if (
        hasActiveSubscription &&
        existingPmRows.length > 0 &&
        existingPmRows[0].customer_profile_id &&
        existingPmRows[0].payment_profile_id
      ) {
        const existingPm = existingPmRows[0];

        const merchantAuthentication = new APIContracts.MerchantAuthenticationType();
        merchantAuthentication.setName(API_LOGIN_ID);
        merchantAuthentication.setTransactionKey(TRANSACTION_KEY);

        const opaque = new APIContracts.OpaqueDataType();
        opaque.setDataDescriptor(opaqueData.dataDescriptor);
        opaque.setDataValue(opaqueData.dataValue);

        const paymentType = new APIContracts.PaymentType();
        paymentType.setOpaqueData(opaque);

        const billTo = new APIContracts.CustomerAddressType();
        const safeUserName = (userName || "").trim();
        const nameParts = safeUserName ? safeUserName.split(/\s+/) : [];
        const fallbackFirst = nameParts[0] || "Customer";
        const fallbackLast = nameParts.slice(1).join(" ") || (nameParts[0] ? "" : "Name");
        const firstNameToUse = (billing && billing.firstName && String(billing.firstName).trim()) || fallbackFirst;
        const lastNameToUse = (billing && billing.lastName && String(billing.lastName).trim()) || fallbackLast;

        billTo.setFirstName(firstNameToUse);
        billTo.setLastName(lastNameToUse);
        if (billing && billing.zip) billTo.setZip(billing.zip);
        if (billing && billing.country) billTo.setCountry(billing.country);

        const paymentProfile = new APIContracts.CustomerPaymentProfileExType();
        paymentProfile.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL);
        paymentProfile.setCustomerPaymentProfileId(String(existingPm.payment_profile_id));
        paymentProfile.setPayment(paymentType);
        paymentProfile.setBillTo(billTo);

        const updateReq = new APIContracts.UpdateCustomerPaymentProfileRequest();
        updateReq.setMerchantAuthentication(merchantAuthentication);
        updateReq.setCustomerProfileId(String(existingPm.customer_profile_id));
        updateReq.setPaymentProfile(paymentProfile);
        updateReq.setValidationMode(getValidationMode());

        const updateCtrl = new APIControllers.UpdateCustomerPaymentProfileController(
          updateReq.getJSON()
        );
        updateCtrl.setEnvironment(getApiEnvironment());

        await new Promise((resolve, reject) => {
          updateCtrl.execute(() => {
            const apiResponse = updateCtrl.getResponse();
            if (!apiResponse) {
              return reject(new Error("Empty response from Authorize.Net"));
            }
            const response = new APIContracts.UpdateCustomerPaymentProfileResponse(
              apiResponse
            );
            if (
              response.getMessages().getResultCode() ===
              APIContracts.MessageTypeEnum.OK
            ) {
              resolve(true);
            } else {
              const msgObj = response.getMessages().getMessage()[0];
              const code = msgObj && msgObj.getCode ? msgObj.getCode() : null;
              const text = msgObj && msgObj.getText ? msgObj.getText() : "Unknown error";
              reject(
                new Error(
                  `Authorize.Net error${code ? ` [${code}]` : ""}: ${text}`
                )
              );
            }
          });
        });

        let cardBrand = null;
        let cardLast4 = null;
        try {
          const getReq = new APIContracts.GetCustomerPaymentProfileRequest();
          getReq.setMerchantAuthentication(merchantAuthentication);
          getReq.setCustomerProfileId(String(existingPm.customer_profile_id));
          getReq.setCustomerPaymentProfileId(String(existingPm.payment_profile_id));

          const getCtrl = new APIControllers.GetCustomerPaymentProfileController(
            getReq.getJSON()
          );
          getCtrl.setEnvironment(getApiEnvironment());

          const getResult = await new Promise((resolve, reject) => {
            getCtrl.execute(() => {
              const apiResponse = getCtrl.getResponse();
              if (!apiResponse) {
                return reject(
                  new Error("Empty response from Authorize.Net (get profile)")
                );
              }
              const response = new APIContracts.GetCustomerPaymentProfileResponse(
                apiResponse
              );
              if (
                response.getMessages().getResultCode() ===
                APIContracts.MessageTypeEnum.OK
              ) {
                resolve(response);
              } else {
                const msgObj = response.getMessages().getMessage()[0];
                const code = msgObj && msgObj.getCode ? msgObj.getCode() : null;
                const text = msgObj && msgObj.getText ? msgObj.getText() : "Unknown error";
                reject(
                  new Error(
                    `Authorize.Net error${code ? ` [${code}]` : ""}: ${text}`
                  )
                );
              }
            });
          });

          const paymentProfileResp =
            getResult.getPaymentProfile && getResult.getPaymentProfile();
          if (paymentProfileResp && paymentProfileResp.getPayment) {
            const payment = paymentProfileResp.getPayment();
            const cc = payment.getCreditCard && payment.getCreditCard();
            if (cc) {
              const maskedNumber = cc.getCardNumber && cc.getCardNumber();
              const cardType = cc.getCardType && cc.getCardType();
              if (maskedNumber && typeof maskedNumber === "string") {
                cardLast4 = maskedNumber.slice(-4);
              }
              if (cardType && typeof cardType === "string") {
                cardBrand = cardType;
              }
            }
          }
        } catch (profileErr) {
          logger.error(
            "Failed to fetch Authorize.Net payment profile details: " +
              profileErr.message
          );
        }

        await pool.query(
          "UPDATE user_payment_methods SET card_brand = ?, card_last4 = ?, is_default = 1 WHERE id = ? AND user_id = ?",
          [cardBrand, cardLast4, existingPm.id, userId]
        );

        paymentMethod = {
          id: existingPm.id,
          customer_profile_id: existingPm.customer_profile_id,
          payment_profile_id: existingPm.payment_profile_id,
          card_brand: cardBrand,
          card_last4: cardLast4,
          is_default: true,
        };
      } else {
        paymentMethod = await createOrAddPaymentProfileForUser({
          userId,
          email,
          opaqueData,
          billing,
          userName,
        });
      }
    } finally {
      try {
        await pool.query("DO RELEASE_LOCK(?)", [lockName]);
      } catch (e) {
        // ignore
      }
    }

    return res.json({
      success: true,
      paymentMethod,
    });
  } catch (err) {
    logger.error("/payments/payment-method error: " + err.message);
    return res.status(400).json({
      success: false,
      message: "Your payment method could not be added. Please try again or use a different card.",
    });
  }
});

// Cancel a subscription for the authenticated user (also cancels in Authorize.Net ARB when possible)
router.post("/subscriptions/:id/cancel", authenticateToken, async (req, res) => {
  const userId = req.user && req.user.id ? req.user.id : res.locals.id;
  const subscriptionId = req.params.id;

  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [subRows] = await connection.query(
      "SELECT id, user_id, status, authorize_subscription_id FROM subscriptions WHERE id = ? AND user_id = ? LIMIT 1",
      [subscriptionId, userId]
    );

    if (!subRows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Subscription not found." });
    }

    const subscription = subRows[0];

    if (subscription.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Only active subscriptions can be canceled.",
      });
    }

    const remoteId = subscription.authorize_subscription_id;

    if (remoteId && API_LOGIN_ID && TRANSACTION_KEY) {
      const merchantAuthentication = new APIContracts.MerchantAuthenticationType();
      merchantAuthentication.setName(API_LOGIN_ID);
      merchantAuthentication.setTransactionKey(TRANSACTION_KEY);

      const cancelRequest = new APIContracts.ARBCancelSubscriptionRequest();
      cancelRequest.setMerchantAuthentication(merchantAuthentication);
      cancelRequest.setSubscriptionId(String(remoteId));

      const ctrl = new APIControllers.ARBCancelSubscriptionController(
        cancelRequest.getJSON()
      );
      ctrl.setEnvironment(getApiEnvironment());

      await new Promise((resolve, reject) => {
        ctrl.execute(() => {
          const apiResponse = ctrl.getResponse();
          if (!apiResponse) {
            return reject(new Error("Empty response from Authorize.Net"));
          }
          const response = new APIContracts.ARBCancelSubscriptionResponse(
            apiResponse
          );
          if (
            response.getMessages().getResultCode() ===
            APIContracts.MessageTypeEnum.OK
          ) {
            resolve(true);
          } else {
            const msg =
              response.getMessages().getMessage()[0].getText() ||
              "Unknown error";
            reject(new Error("Authorize.Net ARB cancel error: " + msg));
          }
        });
      });
    }

    await connection.query(
      "UPDATE subscriptions SET status = 'canceled' WHERE id = ? AND user_id = ?",
      [subscriptionId, userId]
    );

    await syncSubcontractorRole12Rights({
      connection,
      userId,
      planId: null,
    });

    await connection.commit();

    return res.json({
      success: true,
      message: "Subscription canceled.",
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        logger.error(
          "/payments/subscriptions/:id/cancel rollback error: " + rollbackErr.message
        );
      }
    }
    logger.error("/payments/subscriptions/:id/cancel error: " + err.message);
    return res.status(500).json({
      success: false,
      message: "Unable to cancel subscription.",
    });
  } finally {
    if (connection) connection.release();
  }
});

// Update existing payment method (card details) using a new opaqueData token
router.put("/payment-method/:id", authenticateToken, async (req, res) => {
  let lockName;
  let lockAcquired = false;
  try {
    const userId = req.user && req.user.id ? req.user.id : res.locals.id;
    const methodId = req.params.id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    lockName = `payment_method_user_${userId}`;
    const [lockRows] = await pool.query(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [lockName]
    );
    lockAcquired = !!(lockRows && lockRows[0] && lockRows[0].acquired === 1);
    if (!lockAcquired) {
      return res.status(409).json({
        success: false,
        message: "A payment method update is already in progress. Please try again.",
      });
    }

    const { opaqueData, billing } = req.body || {};

    if (!opaqueData || !opaqueData.dataDescriptor || !opaqueData.dataValue) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment token.",
      });
    }

    if (!API_LOGIN_ID || !TRANSACTION_KEY) {
      logger.error("Authorize.Net credentials are not configured.");
      return res.status(500).json({
        success: false,
        message: "Payment configuration error.",
      });
    }

    // Ensure the payment method belongs to this user and fetch profile IDs
    const [rows] = await pool.query(
      "SELECT customer_profile_id, payment_profile_id FROM user_payment_methods WHERE id = ? AND user_id = ? LIMIT 1",
      [methodId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Payment method not found.",
      });
    }

    const { customer_profile_id: customerProfileId, payment_profile_id: paymentProfileId } =
      rows[0];

    const merchantAuthentication = new APIContracts.MerchantAuthenticationType();
    merchantAuthentication.setName(API_LOGIN_ID);
    merchantAuthentication.setTransactionKey(TRANSACTION_KEY);

    const opaque = new APIContracts.OpaqueDataType();
    opaque.setDataDescriptor(opaqueData.dataDescriptor);
    opaque.setDataValue(opaqueData.dataValue);

    const paymentType = new APIContracts.PaymentType();
    paymentType.setOpaqueData(opaque);

    const billTo = new APIContracts.CustomerAddressType();
    if (billing && billing.firstName) billTo.setFirstName(billing.firstName);
    if (billing && billing.lastName) billTo.setLastName(billing.lastName);
    if (billing && billing.zip) billTo.setZip(billing.zip);
    if (billing && billing.country) billTo.setCountry(billing.country);

    const paymentProfile = new APIContracts.CustomerPaymentProfileExType();
    paymentProfile.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL);
    paymentProfile.setCustomerPaymentProfileId(paymentProfileId);
    paymentProfile.setPayment(paymentType);
    paymentProfile.setBillTo(billTo);

    const updateReq = new APIContracts.UpdateCustomerPaymentProfileRequest();
    updateReq.setMerchantAuthentication(merchantAuthentication);
    updateReq.setCustomerProfileId(customerProfileId);
    updateReq.setPaymentProfile(paymentProfile);
    updateReq.setValidationMode(getValidationMode());

    const ctrl = new APIControllers.UpdateCustomerPaymentProfileController(
      updateReq.getJSON()
    );
    ctrl.setEnvironment(getApiEnvironment());

    await new Promise((resolve, reject) => {
      ctrl.execute(() => {
        const apiResponse = ctrl.getResponse();
        if (!apiResponse) {
          return reject(new Error("Empty response from Authorize.Net"));
        }
        const response = new APIContracts.UpdateCustomerPaymentProfileResponse(
          apiResponse
        );
        if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
          resolve(true);
        } else {
          reject(
            new Error(
              "Authorize.Net error: " +
                JSON.stringify(response.getMessages().getMessage()[0].getText())
            )
          );
        }
      });
    });

    return res.json({
      success: true,
      message: "Payment method updated successfully.",
    });
  } catch (err) {
    logger.error("/payments/payment-method/:id error: " + err.message);
    return res.status(400).json({
      success: false,
      message: "Your payment method could not be updated. Please try again.",
    });
  } finally {
    if (lockName && lockAcquired) {
      try {
        await pool.query("DO RELEASE_LOCK(?)", [lockName]);
      } catch (e) {
        // ignore
      }
    }
  }
});

// Get all saved payment methods for the authenticated user
router.get("/payment-methods", authenticateToken, async (req, res) => {
  try {
    const userId = req.user && req.user.id ? req.user.id : res.locals.id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const [rows] = await pool.query(
      "SELECT id, customer_profile_id, payment_profile_id, card_brand, card_last4, is_default, created_at FROM user_payment_methods WHERE user_id = ? ORDER BY is_default DESC, created_at DESC",
      [userId]
    );

    return res.json({
      success: true,
      methods: rows,
    });
  } catch (err) {
    logger.error("/payments/payment-methods error: " + err.message);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch payment methods.",
    });
  }
});

// Delete a saved payment method for the authenticated user
router.delete("/payment-method/:id", authenticateToken, async (req, res) => {
  let lockName;
  let lockAcquired = false;
  try {
    const userId = req.user && req.user.id ? req.user.id : res.locals.id;
    const methodId = req.params.id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    lockName = `payment_method_user_${userId}`;
    const [lockRows] = await pool.query(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [lockName]
    );
    lockAcquired = !!(lockRows && lockRows[0] && lockRows[0].acquired === 1);
    if (!lockAcquired) {
      return res.status(409).json({
        success: false,
        message: "A payment method update is already in progress. Please try again.",
      });
    }

    // Ensure the payment method exists and belongs to the user, and fetch profile IDs
    const [rows] = await pool.query(
      "SELECT id, customer_profile_id, payment_profile_id FROM user_payment_methods WHERE id = ? AND user_id = ? LIMIT 1",
      [methodId, userId]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ success: false, message: "Payment method not found." });
    }

    // Block deletion if the user still has an active subscription.
    const [subRows] = await pool.query(
      "SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active' LIMIT 1",
      [userId]
    );

    if (subRows.length) {
      return res.status(400).json({
        success: false,
        message:
          "You currently have an active subscription. Please cancel the subscription or update your card before removing the payment method.",
      });
    }

    const { customer_profile_id: customerProfileId, payment_profile_id: paymentProfileId } =
      rows[0];

    // Attempt to delete the payment profile in Authorize.Net first, when credentials
    // and profile IDs are available. If this call fails, we keep the local record
    // so that the payment configuration does not become inconsistent.
    if (API_LOGIN_ID && TRANSACTION_KEY && customerProfileId && paymentProfileId) {
      try {
        const merchantAuthentication = new APIContracts.MerchantAuthenticationType();
        merchantAuthentication.setName(API_LOGIN_ID);
        merchantAuthentication.setTransactionKey(TRANSACTION_KEY);

        const deleteReq = new APIContracts.DeleteCustomerPaymentProfileRequest();
        deleteReq.setMerchantAuthentication(merchantAuthentication);
        deleteReq.setCustomerProfileId(String(customerProfileId));
        deleteReq.setCustomerPaymentProfileId(String(paymentProfileId));

        const ctrl = new APIControllers.DeleteCustomerPaymentProfileController(
          deleteReq.getJSON()
        );
        ctrl.setEnvironment(getApiEnvironment());

        await new Promise((resolve, reject) => {
          ctrl.execute(() => {
            const apiResponse = ctrl.getResponse();
            if (!apiResponse) {
              return reject(new Error("Empty response from Authorize.Net"));
            }
            const response = new APIContracts.DeleteCustomerPaymentProfileResponse(
              apiResponse
            );
            if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
              resolve(true);
            } else {
              reject(
                new Error(
                  "Authorize.Net delete payment profile error: " +
                    JSON.stringify(response.getMessages().getMessage()[0].getText())
                )
              );
            }
          });
        });
      } catch (anetErr) {
        logger.error("/payments/payment-method/:id Authorize.Net delete error: " + anetErr.message);
        return res.status(500).json({
          success: false,
          message:
            "Unable to remove payment method from the payment provider. Please try again later.",
        });
      }
    }

    await pool.query("DELETE FROM user_payment_methods WHERE id = ? AND user_id = ?", [
      methodId,
      userId,
    ]);

    return res.json({ success: true, message: "Payment method deleted." });
  } catch (err) {
    logger.error("/payments/payment-method/:id DELETE error: " + err.message);
    return res.status(500).json({
      success: false,
      message: "Unable to delete payment method.",
    });
  } finally {
    if (lockName && lockAcquired) {
      try {
        await pool.query("DO RELEASE_LOCK(?)", [lockName]);
      } catch (e) {
        // ignore
      }
    }
  }
});

// Create a subscription record for the authenticated user.

router.post("/subscriptions", authenticateToken, async (req, res) => {
  const userId = req.user && req.user.id ? req.user.id : res.locals.id;
  const { planId } = req.body || {};

  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  if (!planId) {
    return res.status(400).json({ success: false, message: "planId is required" });
  }

  let connection;
  const lockName = `subscription_change_user_${userId}`;
  let lockAcquired = false;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Prevent duplicate subscription changes (double-click/retry) per user.
    const [lockRows] = await connection.query(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [lockName]
    );
    lockAcquired = !!(lockRows && lockRows[0] && lockRows[0].acquired === 1);
    if (!lockAcquired) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message:
          "A subscription change is already in progress. Please wait a moment and try again.",
      });
    }

    // Ensure the user has a default payment method before allowing subscription.
    const [pmRows] = await connection.query(
      "SELECT id, customer_profile_id, payment_profile_id FROM user_payment_methods WHERE user_id = ? AND is_default = 1 LIMIT 1",
      [userId]
    );

    if (!pmRows.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "No default payment method found. Please add a payment method first.",
      });
    }

    // Load the chosen plan so we can copy amount and interval onto the subscription.
    const [planRows] = await connection.query(
      "SELECT id, name, amount, `interval` FROM plans WHERE id = ? AND is_active = 1 LIMIT 1",
      [planId]
    );

    if (!planRows.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Selected plan is not available.",
      });
    }

    const plan = planRows[0];

    // Check if user already has an active subscription so we can cancel it before creating the new one.
    const [currentSubRows] = await connection.query(
      `SELECT s.id, s.plan_id, s.amount, s.billing_interval, s.next_billing_at, s.authorize_subscription_id
       FROM subscriptions s
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [userId]
    );

    let existingRemoteSubId = null;
    let canceledOldSubscription = false;
    let currentSubForProration = null;

    if (currentSubRows.length) {
      const currentSub = currentSubRows[0];
      currentSubForProration = currentSub;

      // If user selects the same plan, treat as a no-op.
      if (Number(currentSub.plan_id) === Number(planId)) {
        await connection.rollback();
        return res.json({
          success: true,
          message: "You are already subscribed to this plan.",
        });
      }

      // Store the existing remote subscription id so we can cancel it in
      // Authorize.Net before creating the new upgraded subscription.
      if (currentSub.authorize_subscription_id) {
        existingRemoteSubId = String(currentSub.authorize_subscription_id);
      }
    }

    // If there is an existing subscription in Authorize.Net, cancel it before
    // creating the new one (this applies to BOTH upgrades and downgrades).
    if (existingRemoteSubId) {
      try {
        const merchantAuthForCancel = new APIContracts.MerchantAuthenticationType();
        merchantAuthForCancel.setName(API_LOGIN_ID);
        merchantAuthForCancel.setTransactionKey(TRANSACTION_KEY);

        const cancelRequest = new APIContracts.ARBCancelSubscriptionRequest();
        cancelRequest.setMerchantAuthentication(merchantAuthForCancel);
        cancelRequest.setSubscriptionId(existingRemoteSubId);

        const cancelCtrl = new APIControllers.ARBCancelSubscriptionController(
          cancelRequest.getJSON()
        );
        cancelCtrl.setEnvironment(getApiEnvironment());

        await new Promise((resolve, reject) => {
          cancelCtrl.execute(() => {
            const apiResponse = cancelCtrl.getResponse();
            if (!apiResponse) {
              return reject(
                new Error('Empty response from Authorize.Net on cancel')
              );
            }

            const response = new APIContracts.ARBCancelSubscriptionResponse(
              apiResponse
            );

            if (
              response.getMessages().getResultCode() ===
              APIContracts.MessageTypeEnum.OK
            ) {
              canceledOldSubscription = true;
              return resolve(true);
            }

            const msg =
              response.getMessages().getMessage()[0].getText() ||
              'Unknown error';

            // If already terminated, proceed.
            if (String(msg).includes('Subscription is already terminated')) {
              canceledOldSubscription = true;
              return resolve(true);
            }

            return reject(new Error('Authorize.Net ARB cancel error: ' + msg));
          });
        });
      } catch (cancelErr) {
        await connection.rollback();
        logger.error(
          '/payments/subscriptions ARB cancel error: ' + cancelErr.message
        );
        return res.status(400).json({
          success: false,
          message:
            'Unable to modify your current subscription. Please try again later.',
        });
      }
    }

    // Create an ARB subscription in Authorize.Net using the customer's profile.
    const { customer_profile_id, payment_profile_id } = pmRows[0];

    if (!API_LOGIN_ID || !TRANSACTION_KEY) {
      await connection.rollback();
      return res.status(500).json({
        success: false,
        message: "Payment configuration error.",
      });
    }

    const merchantAuthentication = new APIContracts.MerchantAuthenticationType();
    merchantAuthentication.setName(API_LOGIN_ID);
    merchantAuthentication.setTransactionKey(TRANSACTION_KEY);

    const paymentScheduleType = new APIContracts.PaymentScheduleType();
    const interval = new APIContracts.PaymentScheduleType.Interval();

    const planInterval = plan.interval || plan["interval"];
    const isYearly = String(planInterval).toLowerCase() === "yearly";
    interval.setLength(isYearly ? 12 : 1);
    interval.setUnit(APIContracts.ARBSubscriptionUnitEnum.MONTHS);
    paymentScheduleType.setInterval(interval);

    // Start billing immediately: use today's date as the ARB start date
    const startDate = new Date();
    paymentScheduleType.setStartDate(startDate.toISOString().split("T")[0]);
    paymentScheduleType.setTotalOccurrences(9999);

    // Approximate next billing at based on interval.
    const nextBillingAt = new Date(startDate);
    nextBillingAt.setMonth(nextBillingAt.getMonth() + (isYearly ? 12 : 1));

    const profileForSub = new APIContracts.CustomerProfileIdType();
    profileForSub.setCustomerProfileId(String(customer_profile_id));
    profileForSub.setCustomerPaymentProfileId(String(payment_profile_id));

    // Proration credit strategy (via trialAmount/trialOccurrences):
    // credit = (oldAmount / daysInPeriod) * daysRemaining
    // trialAmount = max(0, newAmount - credit)
    // trialOccurrences = 1
    let trialAmountToUse = null;
    let trialOccurrencesToUse = 0;
    let prorationCreditToUse = 0;
    if (
      currentSubForProration &&
      currentSubForProration.amount != null &&
      currentSubForProration.next_billing_at
    ) {
      const oldAmount = Number(currentSubForProration.amount);
      const newAmount = Number(plan.amount);
      const periodEnd = new Date(currentSubForProration.next_billing_at);
      const nowForProration = new Date();

      if (!Number.isNaN(oldAmount) && !Number.isNaN(newAmount) && periodEnd > nowForProration) {
        const msPerDay = 24 * 60 * 60 * 1000;
        const daysRemaining = Math.ceil((periodEnd.getTime() - nowForProration.getTime()) / msPerDay);

        // Use 30 for monthly as requested; yearly uses 365.
        const oldInterval = String(
          currentSubForProration.billing_interval || "monthly"
        ).toLowerCase();
        const daysInPeriod = oldInterval === "yearly" ? 365 : 30;

        const creditRaw = (oldAmount / daysInPeriod) * Math.max(0, daysRemaining);
        const credit = Math.round(creditRaw * 100) / 100;

        if (credit > 0) {
          prorationCreditToUse = credit;
          const discountedFirst = Math.round(Math.max(0, newAmount - credit) * 100) / 100;
          trialOccurrencesToUse = 1;
          trialAmountToUse = discountedFirst;
        }
      }
    }

    const subscriptionRequest = new APIContracts.ARBSubscriptionType();
    subscriptionRequest.setAmount(Number(plan.amount));
    subscriptionRequest.setPaymentSchedule(paymentScheduleType);
    subscriptionRequest.setProfile(profileForSub);
    subscriptionRequest.setName(`${plan.name || "Plan"} for user ${userId}`);

    if (trialOccurrencesToUse === 1 && trialAmountToUse != null) {
      subscriptionRequest.setTrialOccurrences(1);
      subscriptionRequest.setTrialAmount(Number(trialAmountToUse));
    }

    const createSubRequest = new APIContracts.ARBCreateSubscriptionRequest();
    createSubRequest.setMerchantAuthentication(merchantAuthentication);
    createSubRequest.setSubscription(subscriptionRequest);

    const createSubCtrl = new APIControllers.ARBCreateSubscriptionController(
      createSubRequest.getJSON()
    );
    createSubCtrl.setEnvironment(getApiEnvironment());

    let arbSubscriptionId;
    try {
      const createResult = await new Promise((resolve, reject) => {
        createSubCtrl.execute(() => {
          const apiResponse = createSubCtrl.getResponse();
          if (!apiResponse) {
            return reject(new Error("Empty response from Authorize.Net"));
          }
          const response = new APIContracts.ARBCreateSubscriptionResponse(apiResponse);
          if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
            resolve(response);
          } else {
            reject(
              new Error(
                "Authorize.Net ARB error: " +
                  JSON.stringify(response.getMessages().getMessage()[0].getText())
              )
            );
          }
        });
      });

      arbSubscriptionId = createResult.getSubscriptionId();
    } catch (arbErr) {
      await connection.rollback();
      logger.error("/payments/subscriptions ARB create error: " + arbErr.message);
      return res.status(400).json({
        success: false,
        message: canceledOldSubscription
          ? "Your previous subscription was canceled, but the new subscription could not be created. Please contact support."
          : "Unable to create recurring subscription with payment provider. Please verify your payment details or try again.",
      });
    }

    // Deactivate any existing active subscriptions for this user before creating the new one.
    await connection.query(
      "UPDATE subscriptions SET status = 'canceled' WHERE user_id = ? AND status = 'active'",
      [userId]
    );

    const now = new Date();

    const [insertResult] = await connection.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, amount, billing_interval, status, next_billing_at, authorize_subscription_id)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [
        userId,
        plan.id,
        plan.amount,
        plan.interval || plan["interval"],
        nextBillingAt,
        arbSubscriptionId,
      ]
    );

    await syncSubcontractorRole12Rights({
      connection,
      userId,
      planId: plan.id,
    });

    await connection.commit();
    return res.json({
      success: true,
      proration: {
        credit: prorationCreditToUse,
        first_charge: trialAmountToUse != null ? Number(trialAmountToUse) : Number(plan.amount),
        trial_occurrences: trialOccurrencesToUse,
      },
      subscription: {
        id: insertResult.insertId,
        user_id: userId,
        plan_id: plan.id,
        amount: plan.amount,
        billing_interval: plan.interval || plan["interval"],
        status: "active",
        next_billing_at: nextBillingAt,
        authorize_subscription_id: arbSubscriptionId,
        plan_name: plan.name,
      },
    });

  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        logger.error(
          "/payments/subscriptions rollback error: " + rollbackErr.message
        );
      }
    }
    logger.error("/payments/subscriptions error: " + err.message);
    return res.status(500).json({
      success: false,
      message: "Unable to create subscription.",
    });
  } finally {
    if (connection && lockAcquired) {
      try {
        await connection.query("DO RELEASE_LOCK(?)", [lockName]);
      } catch (e) {
        // ignore
      }
    }
    if (connection) connection.release();
  }
});

// Billing status for the authenticated user: payment method + subscription + features
// ...
router.get("/billing/status", authenticateToken, async (req, res) => {
  const userId = req.user && req.user.id ? req.user.id : res.locals.id;

  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  let connection;

  try {
    connection = await pool.getConnection();

    // Decide whose billing information to inspect.
    // Rules:
    // - General contractor (role 14): use their own billing.
    // - All other user types (including subcontractors and employees):
    //   if they have a manager (created_by) who is a GC (role 14),
    //   use that GC's billing; otherwise, fall back to their own.

    let billingUserId = userId;

    try {
      const [userRows] = await connection.query(
        "SELECT id, role, created_by FROM user WHERE id = ? LIMIT 1",
        [userId]
      );

      if (userRows.length) {
        const currentUser = userRows[0];
        const currentRole = Number(currentUser.role);

        if (currentRole === 14) {
          // GC uses their own billing
          billingUserId = currentUser.id;
        } else if (currentRole !== 12 && currentUser.created_by) {
          // Non-GC: try to use their GC manager's billing
          const [managerRows] = await connection.query(
            "SELECT id, role FROM user WHERE id = ? LIMIT 1",
            [currentUser.created_by]
          );

          if (managerRows.length && Number(managerRows[0].role) === 14) {
            billingUserId = managerRows[0].id;
          }
        }
      }
    } catch (resolveErr) {
      logger.error("/payments/billing/status resolve billing user error: " + resolveErr.message);
      // If resolution fails, keep billingUserId as the authenticated user.
      billingUserId = userId;
    }

    // Return a non-sensitive representation of the user's primary payment method.
    // Prefer default card; otherwise fall back to the most recently added card.
    const [pmRows] = await connection.query(
      "SELECT card_brand, card_last4, is_default, created_at FROM user_payment_methods WHERE user_id = ? ORDER BY is_default DESC, created_at DESC LIMIT 1",
      [billingUserId]
    );

    const hasPaymentMethod = pmRows.length > 0;
    const paymentMethod = hasPaymentMethod
      ? {
          brand: pmRows[0].card_brand || null,
          last4: pmRows[0].card_last4 || null,
          is_default: !!pmRows[0].is_default,
          created_at: pmRows[0].created_at || null,
        }
      : null;

    // Check the billing user has an active subscription
    const [subRows] = await connection.query(
      `SELECT s.id, s.plan_id, s.amount, s.billing_interval, s.status,
             s.next_billing_at, s.authorize_subscription_id,
             p.name AS plan_name, p.description AS plan_description
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [billingUserId]
    );

    let hasActiveSubscription = false;
    let subscription = null;
    let features = [];

    if (subRows.length) {
      hasActiveSubscription = true;
      subscription = subRows[0];

      const [featureRows] = await connection.query(
        "SELECT feature_key FROM plan_features WHERE plan_id = ?",
        [subscription.plan_id]
      );

      features = featureRows.map((row) => row.feature_key);
    }

    return res.json({
      success: true,
      hasPaymentMethod,
      paymentMethod,
      hasActiveSubscription,
      subscription,
      features,
    });
  } catch (err) {
    logger.error("/payments/billing/status error: " + err.message);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch billing status.",
    });
  } finally {
    if (connection) connection.release();
  }
});

// Authorize.Net webhook endpoint to keep local subscriptions in sync with ARB events
router.post("/webhook", async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const signatureHeader =
      req.get("X-ANET-SIGNATURE") || req.get("x-anet-signature");

    if (WEBHOOK_SIGNATURE_KEY && signatureHeader) {
      const expected =
        "sha512=" +
        crypto
          .createHmac("sha512", WEBHOOK_SIGNATURE_KEY)
          .update(rawBody, "utf8")
          .digest("hex");

      if (expected !== signatureHeader) {
        logger.warn("/payments/webhook signature mismatch");
        return res.status(401).send("Invalid signature");
      }
    }

    const event = req.body || {};
    const eventType = event.eventType || "";
    const payload = event.payload || {};

    // We care mainly about subscription-related events.
    let subscriptionId =
      payload.id || payload.subscriptionId || payload.subscription_id || null;

    if (!subscriptionId) {
      // Nothing to do for events without a subscription reference.
      return res.status(200).send("Ignored");
    }

    let newStatus = null;

    if (
      eventType === "net.authorize.customer.subscription.cancelled" ||
      eventType === "net.authorize.customer.subscription.terminated"
    ) {
      newStatus = "canceled";
    } else if (
      eventType === "net.authorize.customer.subscription.suspended" ||
      eventType === "net.authorize.customer.subscription.pastdue"
    ) {
      // We do not currently distinguish these in the app; treat as not active.
      newStatus = "canceled";
    } else if (
      eventType === "net.authorize.customer.subscription.created" ||
      eventType === "net.authorize.customer.subscription.updated" ||
      eventType === "net.authorize.customer.subscription.renewed"
    ) {
      // Ensure the local record is active if ARB says so.
      newStatus = "active";
    }

    if (!newStatus) {
      return res.status(200).send("Ignored");
    }

    let connection;
    try {
      connection = await pool.getConnection();

      await connection.query(
        "UPDATE subscriptions SET status = ? WHERE authorize_subscription_id = ?",
        [newStatus, String(subscriptionId)]
      );

      const [subRows] = await connection.query(
        "SELECT user_id, plan_id FROM subscriptions WHERE authorize_subscription_id = ? ORDER BY created_at DESC LIMIT 1",
        [String(subscriptionId)]
      );

      if (subRows.length) {
        const subscription = subRows[0];
        await syncSubcontractorRole12Rights({
          connection,
          userId: subscription.user_id,
          planId: newStatus === "active" ? subscription.plan_id : null,
        });
      }
    } catch (dbErr) {
      logger.error("/payments/webhook DB error: " + dbErr.message);
      // Still return 200 so Authorize.Net does not keep retrying forever.
      return res.status(200).send("Received");
    } finally {
      if (connection) connection.release();
    }

    return res.status(200).send("OK");
  } catch (err) {
    logger.error("/payments/webhook error: " + err.message);
    // Respond 200 to avoid repeated retries; log for manual inspection.
    return res.status(200).send("Error logged");
  }
});

module.exports = router;
