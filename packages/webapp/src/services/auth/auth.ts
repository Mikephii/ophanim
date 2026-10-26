import { createServerFn } from '@tanstack/react-start'

export type SerializableUser = {
  id: string
  email?: string
}

export type SerializableSession = {
  access_token: string
  refresh_token: string
}

export type SignInWithPasswordResponse =
  | { error: string; session: null }
  | { error: null; session: SerializableSession }

export type SignUpWithPasswordResponse =
  | { error: string; session: null }
  | { error: null; session: SerializableSession }

export type GetUserResponse =
  | { isAuthenticated: false; user: null }
  | { isAuthenticated: true; user: SerializableUser }

export const signInWithPassword = createServerFn({ method: 'POST' })
  .inputValidator(
    ({ email, password }: { email: string; password: string }) => {
      if (!email || !password)
        throw new Error('Email and password are required')
      return { email, password }
    },
  )
  .handler(async ({ data, context }): Promise<SignInWithPasswordResponse> => {
    const { SBServerClient: supabase } = context as any
    const { email, password } = data

    const { data: res, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      return {
        error: 'Invalid email or password',
        session: null,
      }
    }

    if (!res.session) {
      return {
        error: 'There was a problem signing you in.',
        session: null,
      }
    }

    return {
      error: null,
      session: {
        access_token: res.session.access_token,
        refresh_token: res.session.refresh_token,
      },
    }
  })

export const signUpWithPassword = createServerFn({ method: 'POST' })
  .inputValidator(
    ({ email, password }: { email: string; password: string }) => {
      if (!email || !password)
        throw new Error('Email and password are required')
      if (password.length < 6)
        throw new Error('Password must be at least 6 characters')
      return { email, password }
    },
  )
  .handler(async ({ data, context }): Promise<SignUpWithPasswordResponse> => {
    const { SBServerClient: supabase } = context as any
    const { email, password } = data

    const { data: res, error } = await supabase.auth.signUp({
      email,
      password,
    })

    if (error) {
      if (error.code === 'email_exists' || error.code === 'user_already_exists') {
        return { error: 'An account with this email already exists', session: null }
      }
      return {
        error: 'There was a problem creating your account.',
        session: null,
      }
    }

    if (!res.session) {
      return { error: 'No session returned', session: null }
    }

    return {
      error: null,
      session: {
        access_token: res.session.access_token,
        refresh_token: res.session.refresh_token,
      },
    }
  })

export const signOut = createServerFn().handler(async ({ context }) => {
  const { SBServerClient: supabase } = context as any
  await supabase.auth.signOut()
})

export const getUser = createServerFn().handler(
  async ({ context }): Promise<GetUserResponse> => {
    const { SBServerClient: supabase } = context as any
    const { data } = await supabase.auth.getUser()

    if (!data.user) {
      return { isAuthenticated: false, user: null }
    }

    return {
      isAuthenticated: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    }
  },
)
