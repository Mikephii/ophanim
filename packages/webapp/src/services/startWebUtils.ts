import { createServerOnlyFn } from '@tanstack/react-start'
import {
  getRequestHeader as getRequestHeaderTSS,
  getCookie as getCookieTSS,
  getCookies as getCookiesTSS,
  setCookie as setCookieTSS,
  deleteCookie as deleteCookieTSS,
  getResponseHeaders as getResponseHeadersTSS,
} from '@tanstack/react-start/server'

export const getRequestHeader = createServerOnlyFn((name: string) => {
  return getRequestHeaderTSS(name)
})

export const getCookie = createServerOnlyFn((name: string) => {
  return getCookieTSS(name)
})

export const getCookies = createServerOnlyFn(() => {
  return getCookiesTSS()
})

export const setCookie = createServerOnlyFn((name: string, value: string) => {
  return setCookieTSS(name, value)
})

export const deleteCookie = createServerOnlyFn((name: string) => {
  return deleteCookieTSS(name)
})

export const getResponseHeaders = createServerOnlyFn(() => {
  return getResponseHeadersTSS()
})
