export const en = {
  nav: 'OAuth Login',
  title: 'OAuth Login',
  loadingAccount: 'Loading accounts…',
  signedOut: 'Not signed in',
  signingIn: 'Waiting for authorization…',
  signedIn: 'Signed in',
  login: 'Sign in',
  loginAgain: 'Sign in again',
  logout: 'Sign out',
  working: 'Working…',
  userCode: 'Code',
  openUrl: 'Authorize',
  requestFailed: 'The login request failed.',
} as const

export type PiLoginKey = keyof typeof en

export const zh: { [Key in PiLoginKey]: string } = {
  nav: 'OAuth 登录',
  title: 'OAuth 登录',
  loadingAccount: '正在加载账户…',
  signedOut: '尚未登录',
  signingIn: '正在等待授权…',
  signedIn: '已登录',
  login: '登录',
  loginAgain: '重新登录',
  logout: '退出',
  working: '处理中…',
  userCode: '授权码',
  openUrl: '授权',
  requestFailed: '登录请求失败。',
}
