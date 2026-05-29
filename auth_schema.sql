-- Ocean MVP Auth + Activity Schema
-- Run this in Supabase SQL Editor (Settings -> SQL Editor)

-- Profiles table (auto-created on user signup)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  phone TEXT,
  signup_source TEXT DEFAULT 'magic_link',
  tier TEXT DEFAULT 'free' CHECK (tier IN ('free', 'trial', 'paid')),
  converted_at TIMESTAMPTZ,
  converted_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Activity log (every user interaction)
CREATE TABLE IF NOT EXISTS public.activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  properties JSONB DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast user activity lookups
CREATE INDEX IF NOT EXISTS idx_activity_log_user_id ON public.activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON public.activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_event ON public.activity_log(event);

-- Profiles: auto-create on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Profiles: auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS profiles_updated_at ON public.profiles;
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read their own profile
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = user_id);

-- Profiles: users can update their own profile
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- Profiles: anon cannot read any profiles
CREATE POLICY "Anon cannot read profiles"
  ON public.profiles FOR SELECT
  USING (false);

-- Activity log: users can read their own activity
CREATE POLICY "Users can read own activity"
  ON public.activity_log FOR SELECT
  USING (auth.uid() = user_id);

-- Activity log: anon cannot read any activity
CREATE POLICY "Anon cannot read activity"
  ON public.activity_log FOR SELECT
  USING (false);

-- Service role (backend only) can manage everything (for future admin use)
-- Note: Never expose service_role key in client-side code

-- Verify setup
SELECT 'profiles table ready' as status;
SELECT count(*) as profile_count FROM public.profiles;
SELECT 'activity_log table ready' as status;
SELECT count(*) as activity_count FROM public.activity_log;