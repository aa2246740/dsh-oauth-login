import type { PiLoginKey } from './locales.ts'

export type LoginAuthType = 'oauth' | 'api_key'
export type LoginChallengeType = 'secret' | 'text' | 'manual_code'

export interface LoginInputCopy {
  waiting: PiLoginKey
  help: PiLoginKey
  placeholder: PiLoginKey
  action: PiLoginKey
  required: PiLoginKey
}

const PLAN_COPY: LoginInputCopy = {
  waiting: 'waitingForCredential', help: 'credentialHelp', placeholder: 'credentialPlaceholder',
  action: 'saveCredential', required: 'credentialRequired',
}

const CALLBACK_COPY: LoginInputCopy = {
  waiting: 'waitingForCallback', help: 'callbackHelp', placeholder: 'callbackPlaceholder',
  action: 'submitCallback', required: 'callbackRequired',
}

const AUTH_INPUT_COPY: LoginInputCopy = {
  waiting: 'waitingForAuthInput', help: 'authInputHelp', placeholder: 'authInputPlaceholder',
  action: 'submitAuthInput', required: 'authInputRequired',
}

/** Select visible copy from the provider contract and the actual Pi challenge. */
export function loginInputCopy(authType: LoginAuthType, challengeType: LoginChallengeType): LoginInputCopy {
  if (authType === 'api_key') return PLAN_COPY
  if (challengeType === 'manual_code') return CALLBACK_COPY
  return AUTH_INPUT_COPY
}
