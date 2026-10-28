-- Defense in depth for sensitive tables.
ALTER TABLE public.card_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_mfa_challenges ENABLE ROW LEVEL SECURITY;
