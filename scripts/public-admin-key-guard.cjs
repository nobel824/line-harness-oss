'use strict';

const FORBIDDEN_PUBLIC_ADMIN_KEY = 'NEXT_PUBLIC_ADMIN_API_KEY';
const ERROR_MESSAGE =
  'Unsafe build configuration: NEXT_PUBLIC_ADMIN_API_KEY must be undefined because NEXT_PUBLIC_* values are embedded in the browser bundle.';

function assertNoPublicAdminKey(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, FORBIDDEN_PUBLIC_ADMIN_KEY)) {
    throw new Error(ERROR_MESSAGE);
  }
}

module.exports = { assertNoPublicAdminKey, ERROR_MESSAGE };
