const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const { authenticateToken } = require("../services/authentication");
const pool = require("../config/connection");
const logger = require("../common/logger");
const { getAccessMode, OWNER_EXEMPT_EMAILS } = require("../utils/access");
const { requireAdmin } = require("../utils/adminGate");
const { sendEmail, isRealEmail } = require("../services/notify");
const { previewAccountDeletion, cascadeDeleteAccount } = require("../services/accountDelete");

// Authorize.Net SDK
const { APIControllers, APIContracts } = require("authorizenet");

// Environment helpers
const API_LOGIN_ID = process.env.AUTHORIZE_API_LOGIN_ID;
const TRANSACTION_KEY = process.env.AUTHORIZE_TRANSACTION_KEY;
const AUTHORIZE_ENV = process.env.AUTHORIZE_ENV || "sandbox"; // "sandbox" or "production"

// Webhook "Signature Key" — a SEPARATE value from the API Login ID / Transaction
// Key. In the Authorize.Net Merchant Interface it is Account → Settings → API
// Credentials & Keys → "Signature Key". It is the HMAC-SHA512 secret used to sign
// the raw webhook body (header `X-ANET-Signature: sha512=<HEX>`). Previously this
// const was never declared, so the /webhook handler threw a ReferenceError on the
// first line and never synced ARB events. AUTHORIZE_WEBHOOK_SIGNATURE_KEY is
// accepted as an alias.
const WEBHOOK_SIGNATURE_KEY =
  process.env.AUTHORIZE_SIGNATURE_KEY ||
  process.env.AUTHORIZE_WEBHOOK_SIGNATURE_KEY ||
  "";

// Public (publishable) values the browser Accept UI needs. The client key is
// SAFE to expose (it only tokenizes cards; it can't move money). Served to the
// frontend by GET /accept-config so the browser always matches whatever
// environment the SERVER is on — flipping AUTHORIZE_ENV (+ the prod keys) on the
// server switches the frontend too, with no separate frontend deploy.
const PUBLIC_CLIENT_KEY = process.env.AUTHORIZE_PUBLIC_CLIENT_KEY || "";
// Default grace window (days) after the sandbox→production flag runs, during which
// affected accounts keep full access while they re-enter a card + re-subscribe.
const REVERIFY_GRACE_DAYS = Number(process.env.REVERIFY_GRACE_DAYS) || 14;
// Current sandbox publishable credentials (previously hardcoded in index.html).
// Used ONLY as a fallback while AUTHORIZE_ENV is sandbox and the env vars aren't
// set yet, so the existing sandbox card form keeps working unchanged. In
// production these are never used — the real prod values MUST come from env.
const SANDBOX_API_LOGIN_ID = "3Eke9v5NS7C";
const SANDBOX_PUBLIC_CLIENT_KEY =
  "8Yh357spP9xaQyxr8PEqbj78Yp9pyG72mQNG38C3Nv745L4M6rSdRj3jLpHk4rqh";

function isProduction() {
  return AUTHORIZE_ENV === "production";
}

function getApiEnvironment() {

  if (isProduction()) {
    // Live Authorize.Net XML endpoint
    return "https://api2.authorize.net/xml/v1/request.api";
  }
  // Sandbox Authorize.Net XML endpoint
  return "https://apitest.authorize.net/xml/v1/request.api";
}

// The Accept UI script host must match the environment of the api login / client
// key (js.authorize.net for production, jstest.authorize.net for sandbox).
function getAcceptUiUrl() {
  return isProduction()
    ? "https://js.authorize.net/v3/AcceptUI.js"
    : "https://jstest.authorize.net/v3/AcceptUI.js";
}

// Detect the "stored payment/customer profile no longer exists" case. Authorize.Net
// returns E00040 ("The record cannot be found.") — expected for EVERY sandbox-era
// profile once the account is switched to production. Detected specifically (not a
// broad catch-all) so we can prompt re-entry instead of showing a generic error.
function isProfileNotFoundError(err) {
  const msg = err && err.message ? String(err.message) : "";
  return (
    msg.includes("E00040") ||
    /record cannot be found/i.test(msg) ||
    /cannot be found/i.test(msg)
  );
}

// Validation mode for CIM customer/payment-profile create + update calls.
// In PRODUCTION we use NONE (not liveMode): liveMode runs a real AVS/auth
// validation transaction when the profile is created, and because we don't collect
// a full billing address (only name + optional zip), that check fails with
// Authorize.Net E00027 ("one or more missing or invalid required fields") — which
// blocked all production card-adds. With NONE, the profile is stored from the
// Accept.js opaque token without that pre-check; the card is validated at the first
// real ARB subscription charge instead. Sandbox stays TESTMODE (unchanged behavior).
// Applies consistently to all three billing paths since each calls this helper:
// createCustomerProfile, createCustomerPaymentProfile, and PUT /payment-method/:id.
function getValidationMode() {
  return AUTHORIZE_ENV === "production"
    ? APIContracts.ValidationModeEnum.NONE
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

    // Create a brand-new customer profile (with its first payment profile).
    // Handles E00039 (a profile with this merchantCustomerId already exists) by
    // reusing the existing id (paymentProfileId comes back null in that case).
    const createFreshCustomerProfile = async () => {
      const pp = new APIContracts.CustomerPaymentProfileType();
      pp.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL);
      pp.setPayment(paymentType);
      pp.setBillTo(billTo);

      const profile = new APIContracts.CustomerProfileType();
      if (email) profile.setEmail(email);
      profile.setMerchantCustomerId(String(userId));
      profile.setPaymentProfiles([pp]);

      const createRequest = new APIContracts.CreateCustomerProfileRequest();
      createRequest.setMerchantAuthentication(merchantAuthentication);
      createRequest.setProfile(profile);
      createRequest.setValidationMode(getValidationMode());

      const ctrl = new APIControllers.CreateCustomerProfileController(createRequest.getJSON());
      ctrl.setEnvironment(getApiEnvironment());

      try {
        const result = await new Promise((resolve, reject) => {
          ctrl.execute(() => {
            const apiResponse = ctrl.getResponse();
            if (!apiResponse) return reject(new Error("Empty response from Authorize.Net"));
            const response = new APIContracts.CreateCustomerProfileResponse(apiResponse);
            if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
              resolve(response);
            } else {
              const msgObj = response.getMessages().getMessage()[0];
              const code = msgObj && msgObj.getCode ? msgObj.getCode() : null;
              const text = msgObj && msgObj.getText ? msgObj.getText() : "Unknown error";
              reject(new Error(`Authorize.Net error${code ? ` [${code}]` : ""}: ${text}`));
            }
          });
        });
        const ppids = result.getCustomerPaymentProfileIdList().getNumericString();
        return {
          customerProfileId: result.getCustomerProfileId(),
          paymentProfileId: Array.isArray(ppids) ? String(ppids[0]) : String(ppids),
        };
      } catch (e) {
        const msg = e && e.message ? String(e.message) : "";
        const hasDuplicateCode = msg.includes("[E00039]") || msg.includes("E00039");
        if (hasDuplicateCode || msg.includes("A duplicate record with ID")) {
          const match = msg.match(/ID (\d+) already exists/);
          if (match && match[1]) return { customerProfileId: match[1], paymentProfileId: null };
        }
        throw e;
      }
    };

    // Add a payment profile under an existing customer profile.
    const addPaymentProfileUnder = async (cpid) => {
      const pp = new APIContracts.CustomerPaymentProfileType();
      pp.setCustomerType(APIContracts.CustomerTypeEnum.INDIVIDUAL);
      pp.setPayment(paymentType);
      pp.setBillTo(billTo);

      const createPayProfReq = new APIContracts.CreateCustomerPaymentProfileRequest();
      createPayProfReq.setMerchantAuthentication(merchantAuthentication);
      createPayProfReq.setCustomerProfileId(cpid);
      createPayProfReq.setPaymentProfile(pp);
      createPayProfReq.setValidationMode(getValidationMode());

      const ctrl = new APIControllers.CreateCustomerPaymentProfileController(createPayProfReq.getJSON());
      ctrl.setEnvironment(getApiEnvironment());

      const result = await new Promise((resolve, reject) => {
        ctrl.execute(() => {
          const apiResponse = ctrl.getResponse();
          if (!apiResponse) return reject(new Error("Empty response from Authorize.Net"));
          const response = new APIContracts.CreateCustomerPaymentProfileResponse(apiResponse);
          if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
            resolve(response);
          } else {
            const m = response.getMessages().getMessage()[0];
            const code = m && m.getCode ? m.getCode() : null;
            const text = m && m.getText ? m.getText() : "Unknown error";
            reject(new Error(`Authorize.Net error${code ? ` [${code}]` : ""}: ${text}`));
          }
        });
      });
      return String(result.getCustomerPaymentProfileId());
    };

    if (!customerProfileId) {
      const fresh = await createFreshCustomerProfile();
      customerProfileId = fresh.customerProfileId;
      createdPaymentProfileId = fresh.paymentProfileId;
    }

    // Add a payment profile under the customer profile. If the STORED profile no
    // longer exists (E00040 — expected for every sandbox-era profile once the
    // account is switched to production), transparently create a FRESH customer
    // profile so re-entering a card just works instead of failing on the stale id.
    if (customerProfileId && !createdPaymentProfileId) {
      try {
        createdPaymentProfileId = await addPaymentProfileUnder(customerProfileId);
      } catch (e) {
        if (isProfileNotFoundError(e)) {
          logger.warn(
            `user_payment_methods: stored customer profile ${customerProfileId} not found (E00040) — creating a fresh profile for user ${userId}`
          );
          const fresh = await createFreshCustomerProfile();
          customerProfileId = fresh.customerProfileId;
          createdPaymentProfileId =
            fresh.paymentProfileId || (await addPaymentProfileUnder(customerProfileId));
        } else {
          throw e;
        }
      }
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

// Public (publishable) Accept UI config for the browser. Follows the server's
// AUTHORIZE_ENV so the frontend tokenizes against the SAME environment the backend
// uses — flip the server .env and the browser follows, no frontend redeploy.
// Returns configured:false (never a sandbox key) if production keys aren't set yet,
// so the frontend can show a clear "temporarily unavailable" instead of misfiring.
router.get("/accept-config", authenticateToken, (req, res) => {
  const production = isProduction();
  const apiLoginId = API_LOGIN_ID || (production ? "" : SANDBOX_API_LOGIN_ID);
  const clientKey = PUBLIC_CLIENT_KEY || (production ? "" : SANDBOX_PUBLIC_CLIENT_KEY);
  return res.json({
    success: true,
    env: production ? "production" : "sandbox",
    acceptUiUrl: getAcceptUiUrl(),
    apiLoginId,
    clientKey,
    configured: !!(apiLoginId && clientKey),
  });
});

// Public plan catalog for the subscribe page — the SINGLE source of truth for
// prices, so card price, confirm-dialog price, and the amount charged
// (createSubscription copies plans.amount) can never diverge. Active plans only,
// and Platinum is excluded (grandfathered/off the public page — its existing
// subscribers keep it via billing/status, which is a separate query). Ordered by
// price ascending (Bid Pro, Basic, Bronze, Silver, Gold).
router.get("/plans", authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query(
      "SELECT id, name, amount, `interval`, is_active FROM plans WHERE is_active = 1 AND LOWER(name) <> 'platinum' ORDER BY amount ASC"
    );
    return res.json({ success: true, plans: rows });
  } catch (err) {
    logger.error("/payments/plans error: " + err.message);
    return res.status(500).json({ success: false, message: "Unable to load plans." });
  } finally {
    if (connection) connection.release();
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
    // Stored profile gone (E00040) — route the user to ADD a fresh card instead
    // of "update", so the sandbox→production transition is graceful.
    if (isProfileNotFoundError(err)) {
      return res.status(409).json({
        success: false,
        code: "PAYMENT_PROFILE_NOT_FOUND",
        message:
          "Your saved card needs to be re-entered. Please add your payment method again — nothing has changed on your bank's side.",
      });
    }
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
      // The stored payment profile doesn't exist on this Authorize.Net account —
      // expected for every sandbox-era profile after the production switch. Tell
      // the user to re-enter their card rather than showing a generic decline.
      if (isProfileNotFoundError(arbErr)) {
        return res.status(409).json({
          success: false,
          code: "PAYMENT_PROFILE_NOT_FOUND",
          message:
            "Your saved card needs to be re-entered before you can subscribe. Please add your payment method again — nothing has changed on your bank's side.",
        });
      }
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
    } else {
      // No subscription: owner-exempt / internal / trial accounts behave as a
      // full (top-tier) paying customer so the GC's own account works on the
      // web too. Expired-free gets none. Mirrors utils/access.js + the jobs and
      // checklist gates.
      let mode = "paid";
      try {
        mode = await getAccessMode(userId);
      } catch (e) {
        mode = "paid";
      }
      if (mode === "paid" || mode === "trial_active") {
        const [allRows] = await connection.query(
          "SELECT DISTINCT feature_key FROM plan_features"
        );
        features = allRows.map((row) => row.feature_key);
      }
    }

    // Sandbox→production re-verification prompt: the billing user has a
    // subscription flagged needs_reverification and no active one. Owner-exempt
    // accounts always read as paid and are never prompted (per the CCP edge case).
    let needsReverification = false;
    let reverificationDueAt = null;
    // Only the ACCOUNT OWNER (the person whose billing this is) is prompted to
    // re-confirm — an employee resolves to their owner's billing but has no card of
    // their own, so they must not see the banner. billingUserId !== userId means the
    // viewer is an employee inheriting someone else's billing → suppress.
    const isBillingOwner = Number(billingUserId) === Number(userId);
    if (!hasActiveSubscription && isBillingOwner) {
      const [reverifyRows] = await connection.query(
        `SELECT reverification_due_at FROM subscriptions
          WHERE user_id = ? AND needs_reverification = 1
          ORDER BY reverification_due_at DESC LIMIT 1`,
        [billingUserId]
      );
      const [emailRows] = await connection.query(
        "SELECT email FROM `user` WHERE id = ? LIMIT 1",
        [billingUserId]
      );
      const billingEmail = String(emailRows[0] && emailRows[0].email ? emailRows[0].email : "").trim().toLowerCase();
      if (reverifyRows.length && !OWNER_EXEMPT_EMAILS.has(billingEmail)) {
        needsReverification = true;
        reverificationDueAt = reverifyRows[0].reverification_due_at || null;
      }
    }

    return res.json({
      success: true,
      hasPaymentMethod,
      paymentMethod,
      hasActiveSubscription,
      subscription,
      features,
      needs_reverification: needsReverification,
      reverification_due_at: reverificationDueAt,
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

// Map an Authorize.Net ARB event type (or status string) to a LOCAL subscription
// status. Local status intentionally stays within the existing value set the rest
// of the app understands ({active, canceled}) — anything that isn't clearly active
// (suspended/terminated/expired/cancelled) means "not billing", so it maps to
// 'canceled'. The admin page surfaces the richer live ARB status separately.
// Returns null for events we don't act on.
function localStatusForArbEvent(eventType) {
  const t = String(eventType || "").toLowerCase();
  if (!t.includes("subscription")) return null;
  if (t.includes("cancel") || t.includes("terminat") || t.includes("suspend") || t.includes("expir")) {
    return "canceled";
  }
  if (t.includes("created") || t.includes("updated") || t.includes("renew")) {
    return "active";
  }
  return null;
}

// Timing-safe, case-insensitive comparison of the received signature against the
// expected HMAC. Authorize.Net sends `X-ANET-Signature: sha512=<HEX>` (upper-case
// hex); we normalise both sides and compare as bytes so a length/format mismatch
// can't throw.
function signatureMatches(expectedHex, headerValue) {
  const received = String(headerValue || "").trim().replace(/^sha512=/i, "").toLowerCase();
  const expected = String(expectedHex || "").toLowerCase();
  if (!received || received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
  } catch (e) {
    return false;
  }
}

// Authorize.Net webhook endpoint to keep local subscriptions in sync with ARB
// events (declines/cancellations/suspensions/renewals initiated outside the app).
// Verifies the HMAC-SHA512 signature over the RAW body before trusting anything.
// Status codes are meaningful: 401 = bad/absent signature, 500 = misconfig or a
// real DB failure (so it is noticed and Authorize.Net retries), 200 = handled or
// intentionally ignored. It no longer swallows processing failures as 200.
router.post("/webhook", async (req, res) => {
  // 1) Authenticity — never trust an unsigned/misconfigured billing webhook.
  if (!WEBHOOK_SIGNATURE_KEY) {
    logger.error(
      "/payments/webhook rejected: AUTHORIZE_SIGNATURE_KEY is not configured — cannot verify webhook authenticity."
    );
    return res.status(500).send("Webhook signature key not configured");
  }

  const rawBody =
    typeof req.rawBody === "string" && req.rawBody.length
      ? req.rawBody
      : JSON.stringify(req.body || {});
  const signatureHeader = req.get("X-ANET-Signature") || req.get("x-anet-signature");

  const expectedHex = crypto
    .createHmac("sha512", WEBHOOK_SIGNATURE_KEY)
    .update(rawBody, "utf8")
    .digest("hex");

  if (!signatureHeader || !signatureMatches(expectedHex, signatureHeader)) {
    logger.warn("/payments/webhook rejected: missing/invalid X-ANET-Signature");
    return res.status(401).send("Invalid signature");
  }

  // 2) Parse + map the event.
  const event = req.body || {};
  const eventType = event.eventType || "";
  const payload = event.payload || {};
  const subscriptionId =
    payload.id || payload.subscriptionId || payload.subscription_id || null;

  const newStatus = localStatusForArbEvent(eventType);

  // Verified, but not an event we act on (or no subscription reference) — ack so
  // Authorize.Net stops retrying. This is a legitimate 200, not a swallowed error.
  if (!subscriptionId || !newStatus) {
    return res.status(200).send("Ignored");
  }

  // 3) Persist. A genuine DB failure here returns 500 (logged + retried), never a
  // silent 200.
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

    logger.info(
      `/payments/webhook applied ${eventType} -> ${newStatus} for ARB subscription ${subscriptionId}`
    );
    return res.status(200).send("OK");
  } catch (dbErr) {
    logger.error("/payments/webhook DB error: " + dbErr.message);
    // Surface the failure so it is retried/noticed rather than lost.
    return res.status(500).send("Processing failed");
  } finally {
    if (connection) connection.release();
  }
});

// ─── Admin: Plan & Payment Status ──────────────────────────────────────────────
// Sensitive billing data — gated by requireAdmin (super-admin 246 OR owner email).

const EMPLOYEE_CATEGORY = 1;
const TRIAL_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const NEVER_GATED_ROLES = new Set([12]);

function isBidProPlan(name, level) {
  return (level === null || level === undefined) && /bid\s*pro/i.test(String(name || ""));
}

// Live ARB subscription status. Returns a lowercase status string
// (active/suspended/expired/canceled/terminated) or throws.
async function getArbSubscriptionStatus(remoteId) {
  const merchantAuthentication = new APIContracts.MerchantAuthenticationType();
  merchantAuthentication.setName(API_LOGIN_ID);
  merchantAuthentication.setTransactionKey(TRANSACTION_KEY);

  const request = new APIContracts.ARBGetSubscriptionStatusRequest();
  request.setMerchantAuthentication(merchantAuthentication);
  request.setSubscriptionId(String(remoteId));

  const ctrl = new APIControllers.ARBGetSubscriptionStatusController(request.getJSON());
  ctrl.setEnvironment(getApiEnvironment());

  return new Promise((resolve, reject) => {
    ctrl.execute(() => {
      const apiResponse = ctrl.getResponse();
      if (!apiResponse) return reject(new Error("Empty response from Authorize.Net"));
      const response = new APIContracts.ARBGetSubscriptionStatusResponse(apiResponse);
      if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
        resolve(String(response.getStatus() || "").toLowerCase());
      } else {
        const m = response.getMessages().getMessage()[0];
        const code = m && m.getCode ? m.getCode() : null;
        const text = m && m.getText ? m.getText() : "unknown";
        reject(new Error(`Authorize.Net ARB status error${code ? ` [${code}]` : ""}: ${text}`));
      }
    });
  });
}

// Map a live ARB status to the local {active|canceled} value set (see the webhook
// note): only 'active' is billing; everything else is treated as not-active.
function localStatusForArbStatus(arbStatus) {
  return String(arbStatus || "").toLowerCase() === "active" ? "active" : "canceled";
}

// Short cache so re-loads / multiple rows don't hammer the ARB API.
const arbStatusCache = new Map(); // remoteId -> { status, at }
const ARB_CACHE_MS = 10 * 60 * 1000;

// GET /payments/admin/subscriptions-overview
// Fast, LOCAL-only snapshot of every user's plan + payment status. No ARB calls
// here (those are lazy, per-row, via /admin/subscription-live/:id) so the page
// never blocks on the payment provider.
router.get(
  "/admin/subscriptions-overview",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    let connection;
    try {
      connection = await pool.getConnection();

      const [users] = await connection.query(
        `SELECT u.id, u.name, u.email, u.role, u.category, u.subcategory, u.created_by, u.created_at,
                r.name AS role_name, c.name AS category_name, sc.name AS subcategory_name
           FROM \`user\` u
           LEFT JOIN role r ON r.id = u.role
           LEFT JOIN category c ON c.id = u.category
           LEFT JOIN subcategory sc ON sc.id = u.subcategory
          ORDER BY u.name ASC`
      );

      const [activeSubs] = await connection.query(
        `SELECT s.id AS sub_id, s.user_id, s.amount, s.billing_interval, s.status,
                s.next_billing_at, s.authorize_subscription_id,
                p.name AS plan_name, p.level AS plan_level
           FROM subscriptions s
           JOIN plans p ON p.id = s.plan_id
          WHERE s.status = 'active'`
      );

      const [pastCounts] = await connection.query(
        `SELECT user_id, COUNT(*) AS c
           FROM subscriptions
          WHERE status <> 'active'
          GROUP BY user_id`
      );

      const [reverifyRows] = await connection.query(
        `SELECT DISTINCT user_id FROM subscriptions WHERE needs_reverification = 1`
      );
      const reverifySet = new Set(reverifyRows.map((r) => Number(r.user_id)));

      // Re-verification grace deadlines — mirror utils/access.getAccessInfo so the
      // admin page's access-mode matches the REAL access an account has. A flagged
      // account (sub canceled at go-live) keeps full "paid" access until its grace
      // deadline; without this the overview computes expired_free for every account
      // the reverify trigger touched, wrongly showing "Expired" + zeroing the paying
      // counters even though access.js still grants them access.
      const [graceRows] = await connection.query(
        `SELECT user_id, MAX(reverification_due_at) AS due
           FROM subscriptions
          WHERE needs_reverification = 1 AND reverification_due_at IS NOT NULL
            AND reverification_due_at > NOW()
          GROUP BY user_id`
      );
      const graceByUser = new Map(graceRows.map((r) => [Number(r.user_id), r.due]));

      // Owned-job counts — distinguish a PURE collaborator (an invited
      // contractor/client who never created a job of their own) from a
      // self-employed contractor running their own business. Keyed by the
      // account's OWN id (a collaborator owns their jobs under their own id).
      let ownsJobsSet = new Set();
      let jobDataOk = false;
      try {
        const [jobOwnerRows] = await connection.query(
          `SELECT created_by AS uid, COUNT(*) AS c
             FROM job WHERE created_by IS NOT NULL GROUP BY created_by`
        );
        ownsJobsSet = new Set(jobOwnerRows.map((r) => Number(r.uid)));
        jobDataOk = true;
      } catch (jobErr) {
        // If ownership can't be determined, DON'T relabel anyone (fail toward the
        // existing behavior rather than mislabeling a self-employed contractor).
        logger.warn("overview: job-owner count unavailable: " + jobErr.message);
      }

      const usersById = new Map();
      users.forEach((u) => usersById.set(Number(u.id), u));

      const activeByUser = new Map(); // userId -> [subs]
      activeSubs.forEach((s) => {
        const k = Number(s.user_id);
        if (!activeByUser.has(k)) activeByUser.set(k, []);
        activeByUser.get(k).push(s);
      });

      const pastByUser = new Map();
      pastCounts.forEach((r) => pastByUser.set(Number(r.user_id), Number(r.c)));

      const rows = users.map((u) => {
        const isEmployee = Number(u.category) === EMPLOYEE_CATEGORY && !!u.created_by;
        const effectiveId = isEmployee ? Number(u.created_by) : Number(u.id);
        const effUser = usersById.get(effectiveId) || u;

        const effEmail = String(effUser.email || "").trim().toLowerCase();
        const effRole = Number(effUser.role);
        const effSubs = activeByUser.get(effectiveId) || [];

        // Separate the tier plan from the Bid Pro add-on.
        const tierSub = effSubs.find((s) => !isBidProPlan(s.plan_name, s.plan_level)) || null;
        const addOnSub = effSubs.find((s) => isBidProPlan(s.plan_name, s.plan_level)) || null;
        const hasActiveSubscription = effSubs.length > 0;

        // Access mode — identical rules to utils/access.getAccessInfo, computed
        // here in JS over the batched data (no per-user DB round trips).
        const createdAt = effUser.created_at ? new Date(effUser.created_at) : null;
        let daysLeft = 0;
        let trialEndsAt = null;
        if (createdAt && !isNaN(createdAt.getTime())) {
          const end = createdAt.getTime() + TRIAL_DAYS * DAY_MS;
          trialEndsAt = new Date(end).toISOString();
          daysLeft = Math.max(0, Math.ceil((end - Date.now()) / DAY_MS));
        }
        const ownerExempt = OWNER_EXEMPT_EMAILS.has(effEmail);
        let accessMode;
        if (ownerExempt || NEVER_GATED_ROLES.has(effRole) || hasActiveSubscription) {
          accessMode = "paid";
        } else if (!createdAt || isNaN(createdAt.getTime())) {
          accessMode = "paid";
        } else {
          accessMode = daysLeft > 0 ? "trial_active" : "expired_free";
        }

        // Grace window (only rescues expired_free, exactly like access.js): a flagged
        // account keeps paid access until its deadline.
        let reverifyGraceUntil = null;
        if (accessMode === "expired_free" && graceByUser.has(effectiveId)) {
          reverifyGraceUntil = graceByUser.get(effectiveId);
          accessMode = "paid";
        }

        // Pure collaborator: no subscription of their own AND has never created a
        // job → an invited-and-accepted contractor/client who was never billed.
        // Labeled "Free Account" (frontend) rather than the misleading "Paying".
        // Employees inherit the owner's account, so they're excluded here.
        //
        // "No subscription record" means NO sub at ALL — active OR past — so a
        // grace-period / former payer (even a canceled sub) is NEVER a free
        // collaborator: their real status genuinely needs the owner's attention.
        //
        // Among never-subscribed accounts, "free" applies when they have nothing
        // usable of their own: EITHER they own zero jobs, OR their own trial has
        // expired (expired_free) so whatever job(s) they created are now fully
        // locked/inaccessible (per the expired-lockout fix) — functionally the same
        // as owning nothing. A never-subscribed account still IN trial with a job of
        // its own is running its business, so its real Trial status stands.
        const hasAnySubscription =
          hasActiveSubscription || (pastByUser.get(effectiveId) || 0) > 0;
        const ownsJobs = ownsJobsSet.has(Number(u.id));
        const freeCollaborator =
          jobDataOk && !isEmployee && !ownerExempt && !NEVER_GATED_ROLES.has(effRole) &&
          !hasAnySubscription && (!ownsJobs || accessMode === "expired_free");

        return {
          id: Number(u.id),
          name: u.name,
          email: u.email,
          role: Number(u.role),
          role_name: u.role_name,
          category: Number(u.category),
          // Human account-type from the category/subcategory reference tables — the
          // reliable discriminator. (u.role is overloaded as a category marker for
          // clients/contractors, so joining `role` mislabels them; see the admin
          // page, which derives its ROLE column from category_name.)
          category_name: u.category_name || null,
          subcategory: u.subcategory != null ? Number(u.subcategory) : null,
          subcategory_name: u.subcategory_name || null,
          is_employee: isEmployee,
          inherits_from: isEmployee
            ? { id: effectiveId, name: effUser.name || null, email: effUser.email || null }
            : null,
          // OWNER-exempt flag is for DISPLAY (the "owner" badge). ownerExempt is
          // computed on the EFFECTIVE (account-owner) user, so an inheriting
          // employee would otherwise inherit the owner's exemption and wrongly show
          // the badge. Scope it to non-employees: only the actual account owner.
          // (Access-mode computation above still uses the effUser-based ownerExempt.)
          owner_exempt: ownerExempt && !isEmployee,
          access_mode: accessMode,
          // Pure collaborators are NOT payers — keep them out of the paying counter.
          free_collaborator: freeCollaborator,
          is_paying: accessMode === "paid" && (hasActiveSubscription || (!ownerExempt && !NEVER_GATED_ROLES.has(effRole))) && !freeCollaborator,
          trial_ends_at: trialEndsAt,
          trial_days_left: daysLeft,
          plan: tierSub
            ? {
                subscription_id: tierSub.sub_id,
                name: tierSub.plan_name,
                level: tierSub.plan_level,
                amount: tierSub.amount,
                interval: tierSub.billing_interval,
                status: tierSub.status,
                next_billing_at: tierSub.next_billing_at,
                authorize_subscription_id: tierSub.authorize_subscription_id,
              }
            : null,
          bid_pro_addon: addOnSub
            ? {
                subscription_id: addOnSub.sub_id,
                name: addOnSub.plan_name,
                amount: addOnSub.amount,
                interval: addOnSub.billing_interval,
                status: addOnSub.status,
                next_billing_at: addOnSub.next_billing_at,
                authorize_subscription_id: addOnSub.authorize_subscription_id,
              }
            : null,
          has_past_subscriptions: (pastByUser.get(Number(u.id)) || 0) > 0,
          needs_reverification: reverifySet.has(effectiveId),
          reverify_grace_until: reverifyGraceUntil,
        };
      });

      return res.status(200).json({ success: true, count: rows.length, users: rows });
    } catch (err) {
      logger.error("/payments/admin/subscriptions-overview error: " + err.message);
      return res.status(500).json({ success: false, message: "Unable to load billing overview." });
    } finally {
      if (connection) connection.release();
    }
  }
);

// GET /payments/admin/subscription-live/:id  (?refresh=1 bypasses the cache)
// Lazy, per-subscription live check against Authorize.Net ARB. If the live status
// disagrees with the local record, it reconciles the local record. On any ARB
// error/timeout it returns checked:false with the local status (so the page shows
// "couldn't verify live" rather than failing).
router.get(
  "/admin/subscription-live/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const subId = Number(req.params.id);
    if (!Number.isFinite(subId) || subId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid subscription id" });
    }
    const force = String(req.query.refresh || "") === "1";

    let connection;
    try {
      connection = await pool.getConnection();
      const [rows] = await connection.query(
        "SELECT id, user_id, plan_id, status, authorize_subscription_id FROM subscriptions WHERE id = ? LIMIT 1",
        [subId]
      );
      if (!rows.length) {
        return res.status(404).json({ success: false, message: "Subscription not found." });
      }
      const sub = rows[0];
      const localBefore = sub.status;
      const remoteId = sub.authorize_subscription_id;

      if (!remoteId) {
        return res.json({ success: true, checked: false, reason: "no_authorize_subscription_id", local_status: localBefore });
      }
      if (!API_LOGIN_ID || !TRANSACTION_KEY) {
        return res.json({ success: true, checked: false, reason: "authnet_not_configured", local_status: localBefore });
      }

      let arbStatus;
      const cached = arbStatusCache.get(String(remoteId));
      if (!force && cached && Date.now() - cached.at < ARB_CACHE_MS) {
        arbStatus = cached.status;
      } else {
        try {
          arbStatus = await getArbSubscriptionStatus(remoteId);
          arbStatusCache.set(String(remoteId), { status: arbStatus, at: Date.now() });
        } catch (e) {
          logger.error("/payments/admin/subscription-live ARB error: " + e.message);
          return res.json({ success: true, checked: false, reason: "authnet_error", error: e.message, local_status: localBefore });
        }
      }

      const mapped = localStatusForArbStatus(arbStatus);
      let reconciled = false;
      if (mapped !== localBefore) {
        await connection.query("UPDATE subscriptions SET status = ? WHERE id = ?", [mapped, subId]);
        await syncSubcontractorRole12Rights({
          connection,
          userId: sub.user_id,
          planId: mapped === "active" ? sub.plan_id : null,
        });
        reconciled = true;
        logger.info(`/payments/admin/subscription-live reconciled sub ${subId}: ${localBefore} -> ${mapped} (ARB=${arbStatus})`);
      }

      return res.json({
        success: true,
        checked: true,
        arb_status: arbStatus,
        local_status: mapped,
        local_status_before: localBefore,
        mismatch: mapped !== localBefore,
        reconciled,
      });
    } catch (err) {
      logger.error("/payments/admin/subscription-live error: " + err.message);
      return res.status(500).json({ success: false, message: "Unable to check live subscription status." });
    } finally {
      if (connection) connection.release();
    }
  }
);

// POST /payments/admin/reverify-sandbox-subscriptions
// ONE-TIME go-live action (owner-run, after switching AUTHORIZE_ENV to production).
// Marks every currently-'active' subscription as needing re-verification and moves
// its status to 'canceled' — these all reference sandbox profiles/ARB ids that don't
// exist on the live account and never actually charged anyone, so they must not keep
// reading as "paying". They stay visible (history + the flag) and their owners get a
// re-add-card prompt. Idempotent-ish: only touches rows still 'active'.
router.post(
  "/admin/reverify-sandbox-subscriptions",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const dryRun = !!(req.body && req.body.dryRun);
    let connection;
    try {
      connection = await pool.getConnection();
      const [before] = await connection.query(
        "SELECT COUNT(*) AS c FROM subscriptions WHERE status = 'active'"
      );
      // Grace window: flagged accounts keep full access (utils/access.js) until
      // this deadline, so the go-live notice can promise uninterrupted service
      // while users re-enter a card + re-subscribe. Overridable via ?graceDays=.
      const graceDays = Math.max(0, Math.min(90, Number(req.query.graceDays) || REVERIFY_GRACE_DAYS));

      // Preview only — how many active subscriptions WOULD be flagged. No mutation.
      if (dryRun) {
        return res.json({
          success: true,
          dryRun: true,
          active_count: before[0] ? Number(before[0].c) : 0,
          grace_days: graceDays,
        });
      }
      const [result] = await connection.query(
        "UPDATE subscriptions SET needs_reverification = 1, status = 'canceled', reverification_due_at = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE status = 'active'",
        [graceDays]
      );
      logger.info(
        `/payments/admin/reverify-sandbox-subscriptions flagged ${result.affectedRows} active subscription(s), ${graceDays}-day grace`
      );
      return res.json({
        success: true,
        active_before: before[0] ? Number(before[0].c) : 0,
        flagged: result.affectedRows || 0,
        grace_days: graceDays,
      });
    } catch (err) {
      logger.error("/payments/admin/reverify-sandbox-subscriptions error: " + err.message);
      return res.status(500).json({ success: false, message: "Unable to flag subscriptions." });
    } finally {
      if (connection) connection.release();
    }
  }
);

// ── Account delete (owner-only) ────────────────────────────────────────────────

// Classify an Authorize.Net ARB *cancel* error as harmless for account deletion.
// Returns true only when the subscription is confirmed to NOT be billing (so the
// account is safe to delete); false for genuine failures where it might still be
// active and must NOT be silently orphaned.
//
// We only ever call cancel on a row whose local status is 'active', and ARB cancel
// on a genuinely active subscription returns OK — so a cancel *error* means one of:
//   (a) the sub/profile doesn't exist on the live account (E00040/E00035 / "record
//       not found") — nothing to cancel; or
//   (b) it's already in a terminal, non-billing state (cancelled / terminated /
//       expired / suspended) — also nothing left to cancel.
// Either way it isn't charging, so deletion is safe. Everything else — auth failure
// (E00007/E00008), connectivity, unknown codes — is REJECTED by the caller so the
// delete transaction rolls back rather than leaving a live recurring charge behind.
function isArbCancelHarmless(code, text) {
  const c = String(code || "");
  const t = String(text || "");
  // (a) not found on the live account
  if (
    /\bE000(?:40|35)\b/i.test(c) ||
    /not\s+be\s+found|\bnot\s+found\b|cannot\s+be\s+found|does\s+not\s+exist/i.test(t)
  ) {
    return true;
  }
  // (b) already in a terminal, non-billing state. Require BOTH a state word and a
  // context signal so an incidental match (e.g. "credentials expired") can't slip
  // through — ARB cancel only errors this way when the sub is already inactive.
  const stateWord = /(cancell?ed|terminat(?:ed|ion)|expired|suspended)/i.test(t);
  const context = /already|has\s+been|have\s+been|\bstatus\b|\bis\s|no\s+longer|currently|cannot\s+be\s+cancell?ed/i.test(t);
  return stateWord && context;
}

// Cancel a live Authorize.Net subscription by its ARB id (reused by the cascade).
async function cancelArbSubscription(remoteId) {
  if (!remoteId || !API_LOGIN_ID || !TRANSACTION_KEY) return;
  const merchantAuthentication = new APIContracts.MerchantAuthenticationType();
  merchantAuthentication.setName(API_LOGIN_ID);
  merchantAuthentication.setTransactionKey(TRANSACTION_KEY);
  const cancelRequest = new APIContracts.ARBCancelSubscriptionRequest();
  cancelRequest.setMerchantAuthentication(merchantAuthentication);
  cancelRequest.setSubscriptionId(String(remoteId));
  const ctrl = new APIControllers.ARBCancelSubscriptionController(cancelRequest.getJSON());
  ctrl.setEnvironment(getApiEnvironment());
  await new Promise((resolve, reject) => {
    ctrl.execute(() => {
      const apiResponse = ctrl.getResponse();
      if (!apiResponse) return reject(new Error("Empty response from Authorize.Net"));
      const response = new APIContracts.ARBCancelSubscriptionResponse(apiResponse);
      if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) return resolve(true);
      const msg = (response.getMessages().getMessage() || [])[0] || {};
      const code = msg.getCode ? msg.getCode() : "";
      const text = (msg.getText ? msg.getText() : "") || "Unknown error";
      // Safe to proceed only when the subscription is confirmed NOT billing (not
      // found, or already cancelled/terminated/expired/suspended). Anything else
      // might be a still-active sub we failed to cancel — reject so the caller's
      // delete transaction rolls back instead of orphaning a live recurring charge.
      if (isArbCancelHarmless(code, text)) return resolve(true);
      return reject(new Error(`Authorize.Net ARB cancel error${code ? ` [${code}]` : ""}: ${text}`));
    });
  });
}

// GET /payments/admin/account-delete-preview/:userId
// Step-2 dry run: exact counts the owner reviews before typing the email to confirm.
router.get(
  "/admin/account-delete-preview/:userId",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const targetId = Number(req.params.userId);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid user id." });
    }
    let connection;
    try {
      connection = await pool.getConnection();
      const preview = await previewAccountDeletion(connection, targetId);
      if (!preview) return res.status(404).json({ success: false, message: "Account not found." });
      return res.json({ success: true, preview });
    } catch (err) {
      logger.error("/payments/admin/account-delete-preview error: " + err.message);
      return res.status(500).json({ success: false, message: "Unable to build the delete preview." });
    } finally {
      if (connection) connection.release();
    }
  }
);

// DELETE /payments/admin/account/:userId
// Permanent cascade delete. Body must include { confirmEmail } matching the target's
// email (server-side re-check — the client typing it is not trusted on its own).
// Owner-exempt accounts (the platform owners) can never be deleted here.
router.delete(
  "/admin/account/:userId",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const targetId = Number(req.params.userId);
    const confirmEmail = String((req.body && req.body.confirmEmail) || "").trim().toLowerCase();
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ success: false, message: "Invalid user id." });
    }
    if (Number(req.user && req.user.id) === targetId) {
      return res.status(400).json({ success: false, message: "You cannot delete your own account here." });
    }
    let connection;
    try {
      connection = await pool.getConnection();
      const [rows] = await connection.query(
        "SELECT id, email FROM `user` WHERE id = ? LIMIT 1",
        [targetId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: "Account not found." });
      const email = String(rows[0].email || "").trim().toLowerCase();

      // The typed email must match the target account (defence against mis-click / wrong row).
      if (!confirmEmail || confirmEmail !== email) {
        return res.status(400).json({ success: false, code: "CONFIRM_MISMATCH", message: "The typed email does not match this account." });
      }
      // Never allow deleting a platform-owner-exempt account through this tool.
      if (OWNER_EXEMPT_EMAILS.has(email)) {
        return res.status(403).json({ success: false, code: "OWNER_PROTECTED", message: "This is a protected owner account and cannot be deleted." });
      }

      await connection.beginTransaction();
      let result;
      try {
        result = await cascadeDeleteAccount(connection, targetId, { cancelArb: cancelArbSubscription });
        await connection.commit();
      } catch (e) {
        await connection.rollback();
        throw e;
      }
      logger.info(`/payments/admin/account delete: uid ${targetId} (${email}) by ${req.user && req.user.id} — ${JSON.stringify(result.tables)}`);
      return res.json({ success: true, deleted_user_id: targetId, ...result });
    } catch (err) {
      logger.error("/payments/admin/account delete error: " + err.message);
      return res.status(500).json({ success: false, message: "Unable to delete the account. Nothing was deleted." });
    } finally {
      if (connection) connection.release();
    }
  }
);

// ── Owner-triggered re-verification emails (A = heads-up, B = action) ──────────
// Approved copy from the prior CCP, personalized per recipient. Sent only when the
// owner explicitly triggers it (never scheduled). Audience mirrors the in-app
// banner: account owners only (subscriptions belong to owners, so employees are
// inherently excluded), minus owner-exempt + anyone without a real email.

function fmtDate(d) {
  try {
    return new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch (e) {
    return String(d || "");
  }
}

const DASHBOARD_URL = "https://seejobrun.com/user-dashboard";

function buildReverifyEmail(type, { firstName, migrationDate, deadline }) {
  const hi = `Hi ${firstName || "there"},`;
  if (type === "A") {
    const when = migrationDate ? fmtDate(migrationDate) : "shortly";
    const subject = "A small upgrade to SeeJobRun billing — quick action coming";
    const text =
      `${hi}\n\nWe're upgrading the secure payment system behind SeeJobRun on ${when}. ` +
      `After that, you'll need to re-confirm your payment card and plan — a quick one-time step.\n\n` +
      `Nothing is happening to your account or data, and there's nothing to do yet. When the upgrade goes live ` +
      `you'll have a 14-day window (and an in-app reminder) to re-confirm, with no interruption to your access in the meantime. ` +
      `We'll send simple instructions then.\n\nThanks for being with us,\nSeeJobRun`;
    const html =
      `<p>${hi}</p><p>We're upgrading the secure payment system behind SeeJobRun on <strong>${when}</strong>. ` +
      `After that, you'll need to re-confirm your payment card and plan — a quick one-time step.</p>` +
      `<p>Nothing is happening to your account or data, and there's nothing to do yet. When the upgrade goes live ` +
      `you'll have a <strong>14-day window</strong> (and an in-app reminder) to re-confirm, with <strong>no interruption to your access</strong> in the meantime. ` +
      `We'll send simple instructions then.</p><p>Thanks for being with us,<br/>SeeJobRun</p>`;
    return { subject, text, html };
  }
  // type B
  const by = deadline ? fmtDate(deadline) : "the date shown in the app";
  const subject = `Action needed: re-confirm your payment method by ${by}`;
  const text =
    `${hi}\n\nOur payment system upgrade is now live. To keep your subscription active, please re-confirm your card and plan by ${by}. ` +
    `Your full access continues until then.\n\n` +
    `A couple of reassurances: your account and data are safe, and nothing has been charged during this upgrade.\n\n` +
    `It takes about a minute:\n` +
    `1. Log in at ${DASHBOARD_URL}\n` +
    `2. Go to Profile → Payment Methods → Add Card\n` +
    `3. Open Subscription and choose your plan to confirm\n\n` +
    `Questions? Just reply to this email.\n\nThanks,\nSeeJobRun`;
  const html =
    `<p>${hi}</p><p>Our payment system upgrade is now live. To keep your subscription active, please re-confirm your card and plan by <strong>${by}</strong>. ` +
    `Your full access continues until then.</p>` +
    `<p>A couple of reassurances: your account and data are safe, and nothing has been charged during this upgrade.</p>` +
    `<p>It takes about a minute:</p><ol>` +
    `<li>Log in at <a href="${DASHBOARD_URL}">${DASHBOARD_URL}</a></li>` +
    `<li>Go to <strong>Profile → Payment Methods → Add Card</strong></li>` +
    `<li>Open <strong>Subscription</strong> and choose your plan to confirm</li></ol>` +
    `<p>Questions? Just reply to this email.</p><p>Thanks,<br/>SeeJobRun</p>`;
  return { subject, text, html };
}

// POST /payments/admin/send-reverification-email
// body: { emailType: 'A'|'B', migrationDate?: 'YYYY-MM-DD' (required for A send),
//         dryRun?: boolean }
// dryRun returns the computed recipient list WITHOUT sending, so the owner can
// review it against the Plan & Payment Status page before actually sending.
router.post(
  "/admin/send-reverification-email",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const emailType = String((req.body && req.body.emailType) || "").toUpperCase();
    const dryRun = !!(req.body && req.body.dryRun);
    const migrationDate = req.body && req.body.migrationDate ? String(req.body.migrationDate) : "";
    if (emailType !== "A" && emailType !== "B") {
      return res.status(400).json({ success: false, message: "emailType must be 'A' or 'B'." });
    }
    if (emailType === "A" && !dryRun && !migrationDate) {
      return res.status(400).json({ success: false, message: "migrationDate is required to send Email A." });
    }
    const triggeredBy = (req.user && req.user.id) || (res.locals && res.locals.id) || null;

    let connection;
    try {
      connection = await pool.getConnection();

      // Audience: account owners. Email A → those with an active sub (about to be
      // flagged); Email B → those already flagged needs_reverification. Subscriptions
      // belong to owners, so employees are inherently excluded.
      const sql =
        emailType === "B"
          ? // Flagged owners who have NOT yet re-subscribed. Excluding anyone with a
            // current active subscription means a repeat send is a safe reminder to
            // non-responders — people who already re-added a card + re-subscribed
            // drop out automatically (their old flagged row is ignored).
            `SELECT s.user_id AS id, u.name, u.email, MAX(s.reverification_due_at) AS due
               FROM subscriptions s JOIN \`user\` u ON u.id = s.user_id
              WHERE s.needs_reverification = 1
                AND NOT EXISTS (
                  SELECT 1 FROM subscriptions a WHERE a.user_id = s.user_id AND a.status = 'active'
                )
              GROUP BY s.user_id, u.name, u.email`
          : `SELECT s.user_id AS id, u.name, u.email, NULL AS due
               FROM subscriptions s JOIN \`user\` u ON u.id = s.user_id
              WHERE s.status = 'active'
              GROUP BY s.user_id, u.name, u.email`;
      const [rows] = await connection.query(sql);

      const recipients = [];
      const skipped = [];
      for (const r of rows) {
        const email = String(r.email || "").trim();
        if (OWNER_EXEMPT_EMAILS.has(email.toLowerCase())) {
          skipped.push({ id: r.id, name: r.name, reason: "owner-exempt" });
          continue;
        }
        if (!isRealEmail(email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          skipped.push({ id: r.id, name: r.name, reason: "no valid email on file" });
          continue;
        }
        recipients.push({ id: r.id, name: r.name, email, due: r.due });
      }

      if (dryRun) {
        return res.json({
          success: true,
          dryRun: true,
          emailType,
          total: recipients.length,
          recipients: recipients.map((r) => ({ id: r.id, name: r.name, email: r.email })),
          skipped,
        });
      }

      let sent = 0;
      const failed = [];
      for (const r of recipients) {
        const firstName = String(r.name || "").trim().split(/\s+/)[0] || "there";
        const deadline = r.due ? r.due : "";
        const msg = buildReverifyEmail(emailType, { firstName, migrationDate, deadline });
        const okSend = await sendEmail(r.email, msg.subject, msg.text, msg.html);
        try {
          await connection.query(
            `INSERT INTO reverification_email_log (user_id, email_type, recipient_email, status, triggered_by)
             VALUES (?, ?, ?, ?, ?)`,
            [r.id, emailType, r.email, okSend ? "sent" : "failed", triggeredBy]
          );
        } catch (logErr) {
          logger.error("reverification_email_log insert failed: " + logErr.message);
        }
        if (okSend) sent++;
        else failed.push({ id: r.id, email: r.email });
      }

      logger.info(
        `/payments/admin/send-reverification-email type=${emailType} sent=${sent} failed=${failed.length} skipped=${skipped.length} by=${triggeredBy}`
      );
      return res.json({ success: true, emailType, total: recipients.length, sent, failed, skipped });
    } catch (err) {
      logger.error("/payments/admin/send-reverification-email error: " + err.message);
      return res.status(500).json({ success: false, message: "Unable to send re-verification emails." });
    } finally {
      if (connection) connection.release();
    }
  }
);

// GET /payments/admin/reverification-email-log
// Read-only history of the re-verification email sends (reads the existing
// reverification_email_log as-is). Newest first; joins names for display.
router.get(
  "/admin/reverification-email-log",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    let connection;
    try {
      connection = await pool.getConnection();
      const [rows] = await connection.query(
        `SELECT l.id, l.user_id, u.name AS user_name, l.email_type, l.recipient_email,
                l.status, l.sent_at, l.triggered_by, t.name AS triggered_by_name
           FROM reverification_email_log l
           LEFT JOIN \`user\` u ON u.id = l.user_id
           LEFT JOIN \`user\` t ON t.id = l.triggered_by
          ORDER BY l.sent_at DESC, l.id DESC
          LIMIT 1000`
      );
      const [counts] = await connection.query(
        `SELECT status, COUNT(*) AS c FROM reverification_email_log GROUP BY status`
      );
      const summary = counts.reduce((m, r) => { m[r.status] = Number(r.c); return m; }, {});
      return res.status(200).json({ success: true, entries: rows, summary });
    } catch (err) {
      logger.error("/payments/admin/reverification-email-log error: " + err.message);
      return res.status(500).json({ success: false, message: "Unable to load send history." });
    } finally {
      if (connection) connection.release();
    }
  }
);

module.exports = router;
// Exposed for unit tests (ARB cancel error classification — account-delete safety).
module.exports.isArbCancelHarmless = isArbCancelHarmless;
