import Joi from 'joi';

/**
 * Input validation (STORY-032 / REQ-003, REQ-004, REQ-008).
 *
 * Measured before this: 78 routes, no validation library, and malformed input
 * sent to every one of them came back as a **500 on 28 routes** — raw Postgres
 * errors (`invalid input syntax for type bigint: "NaN"`), and three JavaScript
 * crashes (`platforms.includes is not a function`) from handlers assuming types
 * nobody checked. Worse than the crashes: `POST /authors` with
 * `{ name: 123, email: ["x"] }` answered 201 and stored an author whose email
 * is the literal text `{"x"}`. Postgres coerced a JavaScript array into a text
 * array literal and nothing stood in front of it.
 *
 * A 500 on bad input is two failures at once: the caller is told the server
 * broke when it was the request that was wrong, and the error message — a
 * database's own words — is handed to whoever sent it.
 *
 * Each route declares what it reads, per part (`params`, `query`, `body`), and
 * the handler receives only what was declared, converted to the declared type.
 * Unknown keys are stripped rather than refused: the UI sends a few fields some
 * handlers ignore, and refusing them would turn a harmless extra into an
 * outage. What makes stripping safe is `tests/inputValidation.test.js`, which
 * reads every handler's source and fails if it reads a field its schema does
 * not declare — otherwise stripping would silently delete a field a handler
 * needs, which is a worse bug than the one this fixes.
 */

const OPTIONS = { abortEarly: false, stripUnknown: true, convert: true };

/** A row id: a positive integer, as the bigserial columns it addresses are. */
export const id = Joi.number().integer().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * A calendar date as the handlers already use it — `YYYY-MM-DD`, kept a
 * string. `Joi.date()` would hand the handler a Date object and
 * `string().isoDate()` rewrites it to a timestamp, and either would change
 * what reaches SQL for code that has compared these as strings since R0.
 */
export const dateOnly = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message('{{#label}} must be a date as YYYY-MM-DD');

/** A moment, as any string `Date` can read. Left a string for the same reason. */
export const timestamp = Joi.string().max(64).custom((value, helpers) =>
  Number.isNaN(Date.parse(value)) ? helpers.error('any.invalid') : value,
).messages({ 'any.invalid': '{{#label}} must be a date and time' });

/** Free text with a ceiling. A note is not a novel, and a 4 MB note is an attack. */
export const text = (max = 2000) => Joi.string().allow('').max(max);

/**
 * Validates and converts the declared parts of a request.
 *
 * Returns middleware carrying `.validates`, the list of parts it checks, so
 * the coverage test can read the route table and see what is guarded — the
 * same move STORY-024 made for tenant walking: derive coverage from the live
 * router rather than trust a list somebody maintains by hand.
 */
export function validate(schemas) {
  const compiled = Object.fromEntries(
    Object.entries(schemas).map(([part, schema]) => [
      part,
      Joi.isSchema(schema) ? schema : Joi.object(schema),
    ]),
  );

  const middleware = (req, _res, next) => {
    const problems = [];
    for (const [part, schema] of Object.entries(compiled)) {
      // A JSON array body is valid JSON and not an object; say so rather than
      // letting Joi report every declared field as missing from index 0.
      if (part === 'body' && Array.isArray(req.body)) {
        problems.push({ part, path: '', message: 'request body must be a JSON object, not an array' });
        continue;
      }
      const { error, value } = schema.validate(req[part] ?? {}, OPTIONS);
      if (error) {
        for (const d of error.details) {
          problems.push({ part, path: d.path.join('.'), message: d.message.replace(/"/g, '') });
        }
      } else {
        req[part] = value;
      }
    }
    if (problems.length > 0) {
      return next(
        Object.assign(
          new Error(`Invalid request: ${problems.map((p) => (p.path ? `${p.part}.${p.path}` : p.part) + ' — ' + p.message).join('; ')}`),
          { status: 400, details: problems },
        ),
      );
    }
    return next();
  };

  middleware.validates = Object.keys(compiled);
  middleware.schemas = compiled;
  return middleware;
}

/**
 * Path parameters, checked once for every route that names them.
 *
 * Hung off `router.param` rather than repeated per route, for the reason
 * `tenantParam` is: a route added next month that names `:id` is guarded
 * without anyone remembering to guard it. This alone takes eighteen of the
 * twenty-eight crashing routes to a 400 — every row-addressed action crashed on
 * a non-numeric id, because each one did `Number(req.params.id)` and handed
 * `NaN` to Postgres.
 */
export function numericParam(name) {
  return (req, _res, next, value) => {
    const { error, value: converted } = id.label(name).validate(value, OPTIONS);
    if (error) {
      return next(
        Object.assign(new Error(`Invalid request: params.${name} must be a positive whole number`), {
          status: 400,
          details: [{ part: 'params', path: name, message: `${name} must be a positive whole number` }],
        }),
      );
    }
    req.params[name] = converted;
    return next();
  };
}
