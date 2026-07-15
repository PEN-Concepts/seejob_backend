const Joi = require("joi");

function addUserSchema(user) {
  const schema = Joi.object({
    name: Joi.string().min(3).max(50).required().messages({
      "string.base": "Name must be a string",
      "string.min": "Name must be at least 3 characters long",
      "string.max": "Name cannot exceed 50 characters",
      "any.required": "Name is required",
    }),
    email: Joi.string()
      .email({
        minDomainSegments: 2,
      })
      .required()
      .messages({
        "string.email": "Please provide a valid email",
        "any.required": "Email is required",
      }),
    secondary_email: Joi.string()
      .email({ minDomainSegments: 2 })
      .optional()
      .allow("")
      .messages({
        "string.email": "Please provide a valid secondary email",
      }),
    password: Joi.string().min(8).allow("").optional().messages({
      "string.min": "Password should be equal to or greater than 8 charaters",
    }),

    mobile: Joi.string()
      .custom((value, helpers) => {
        const cleaned = value.replace(/\D/g, ""); // remove non-digits
        if (cleaned.length !== 10) {
          return helpers.error("any.invalid");
        }
        return cleaned; // pass the cleaned number
      })
      .required()
      .messages({
        "any.invalid": "Mobile must be exactly 10 digits (USA format).",
        "any.required": "Mobile is a required field.",
      }),

    street_address: Joi.string().optional().allow("").messages({
      // "string.empty": "Street Address is required",
      // "any.required": "Street Address is required"
    }),
    city: Joi.string().optional().allow("").messages({
      // "string.empty": "City/Town is required",
      // "any.required": "City/Town is required"
    }),

    state: Joi.string().optional().allow("").messages({
      // "string.empty": "State is required",
      // "any.required": "State is required"
    }),
    time_zone: Joi.string().optional().allow("").valid(
    'EST',
    'CST',
    'MST_DENVER',
    'MST_PHOENIX',
    'PST',
    'AKST',
    'HST'
  ).messages({
      // "string.empty": "State is required",
      // "any.required": "State is required"
    }),

    // Canonical IANA timezone (e.g. 'America/Los_Angeles'). Free-form string
    // (IANA has hundreds of zones); just length-capped. Distinct from the legacy
    // short-code `time_zone` above.
    timezone: Joi.string().optional().allow("").max(64).messages({}),

    zipcode: Joi.string().optional().allow("").messages({
      // "string.empty": "City/Town is required",
      // "any.required": "City/Town is required"
    }),

    contact_notes: Joi.string().optional().allow("").messages({
      // "string.empty": "City/Town is required",
      // "any.required": "City/Town is required"
    }),

    category: Joi.number().required().messages({
      "number.base": "Category must be a number",
      "any.required": "Category is required",
    }),
    subcategory: Joi.number().optional().allow("").messages({
      // "number.base": "Subcategory must be a number",
      // "any.required": "Subcategory is required"
    }),
    leave_ids: Joi.array().items(Joi.number()).optional().messages({
      "array.base": "Leave IDs must be an array",
      "number.base": "Each Leave ID must be a number",
    }),
    employment_type: Joi.string().optional().allow(""),
      rate: Joi.number().optional(),

    business_name: Joi.string().optional().allow("").messages({}),

    business: Joi.string().optional().allow("").messages({}),

    organization_name: Joi.string().optional().allow("").messages({}),

    trade: Joi.string().optional().allow("").messages({}),

    social_security_num: Joi.string().optional().allow("").messages({}),
    show_email: Joi.alternatives()
      .try(
        Joi.boolean(),
        Joi.number().valid(0, 1),
        Joi.string().valid("0", "1", "")
      )
      .optional()
      .messages({
        "alternatives.match":
          "Show Email to Clients must be true, false, 0, or 1",
      }),
  

        social_security_num: Joi.string().optional().allow("").messages({

        }),
        created_by: Joi.number().optional().allow("").messages({

        }),
        pin_enabled: Joi.number().optional().allow("").messages({
        }),
        
        
    });

    return schema.validate(user, { abortEarly: false });
}

module.exports.addUserSchema = addUserSchema;
