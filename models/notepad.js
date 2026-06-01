const Joi = require("joi");


function addcontactSchema(user) {
    const schema = Joi.object({
        user_id: Joi.number().required().messages({
                    "number.base": "Contact must be a number",
                    "any.required": "Contact is required"
                  }),
        created_by: Joi.number().optional().allow("").messages({
                  
                          }),
            });
            

    return schema.validate(user, { abortEarly: false });
}

module.exports.addcontactSchema = addcontactSchema;