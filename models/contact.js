const Joi = require("joi");

function contactSchema(contact) {
    const schema = Joi.object({
        request_to: Joi.string().required().messages({
            "string.empty": "Contact is required",
            "any.required": "Contact is required"
        }),
    });

    return schema.validate(contact, { abortEarly: false });
}

module.exports.contactSchema = contactSchema;
