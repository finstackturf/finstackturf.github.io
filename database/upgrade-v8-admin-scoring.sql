-- ============================================================================
-- FINSTACK TURF — v8: scoring is admin-only; captains still pick line-ups.
-- Safe to re-run.
-- ============================================================================
-- can_score() is used by start_match, score_ball, undo_ball, set_innings_total,
-- end_match and set_match_overs → now admin only.
create or replace function public.can_score(p_match_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select public.is_approved_admin(); $$;
revoke all on function public.can_score(uuid) from public, anon, authenticated;

-- Captains (or admin) may still pick teams.
create or replace function public.can_pick_teams(p_match_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.is_approved_admin() or exists (
    select 1 from public.matches m where m.id = p_match_id and public.current_profile_id() in (m.captain_a, m.captain_b));
$$;
revoke all on function public.can_pick_teams(uuid) from public, anon, authenticated;

create or replace function public.set_match_teams(p_match_id uuid, p_assignments jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare v_row public.matches%rowtype; r record; v_a int; v_b int;
begin
  if not public.can_pick_teams(p_match_id) then raise exception 'Only the admin or the captains can pick teams'; end if;
  select * into v_row from public.matches where id = p_match_id for update;
  if not found then raise exception 'Match not found'; end if;
  if v_row.status = 'voting' then raise exception 'Close voting first — teams are picked from the locked team sheet'; end if;
  if v_row.play_status = 'completed' then raise exception 'This match is finished'; end if;
  delete from public.match_teams where match_id = p_match_id;
  for r in select (e->>'profile_id')::uuid as pid, upper(e->>'team') as team from jsonb_array_elements(coalesce(p_assignments,'[]'::jsonb)) e loop
    if r.team not in ('A','B') then continue; end if;
    if not exists (select 1 from public.match_attendance where match_id = p_match_id and profile_id = r.pid) then raise exception 'All players must be on the team sheet'; end if;
    insert into public.match_teams(match_id, profile_id, team) values (p_match_id, r.pid, r.team) on conflict (match_id, profile_id) do update set team = excluded.team;
  end loop;
  select count(*) filter (where team='A'), count(*) filter (where team='B') into v_a, v_b from public.match_teams where match_id = p_match_id;
  perform public.notify_profiles(public.everyone_except(public.current_profile_id()), 'activity', 'Teams updated: ' || public.match_label(v_row),
    v_row.team_a_name || ' (' || v_a || ') vs ' || v_row.team_b_name || ' (' || v_b || ') · picked by ' || public.my_name() || '.', p_match_id);
end;
$$;
revoke all on function public.set_match_teams(uuid,jsonb) from public, anon;
grant execute on function public.set_match_teams(uuid,jsonb) to authenticated;
