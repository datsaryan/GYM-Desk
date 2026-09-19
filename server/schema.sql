create table if not exists gyms (
  id serial primary key,
  name text not null,
  template text not null default 'Hi {name}, your {plan} membership at {gym} {when}. Please renew at the counter or by UPI so you can carry on without a break.',
  created_at timestamptz not null default now()
);

create table if not exists users (
  id serial primary key,
  gym_id int not null references gyms(id) on delete cascade,
  name text not null,
  email text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));

create table if not exists plans (
  id serial primary key,
  gym_id int not null references gyms(id) on delete cascade,
  name text not null,
  months int not null check (months between 1 and 60),
  price int not null check (price >= 0),
  position int not null default 0
);
create index if not exists plans_gym_idx on plans (gym_id);

create table if not exists members (
  id serial primary key,
  gym_id int not null references gyms(id) on delete cascade,
  name text not null,
  phone text not null default '',
  plan_id int references plans(id) on delete set null,
  plan_name text not null,
  start_date date not null,
  expiry_date date not null,
  joined_on date not null,
  due int not null default 0 check (due >= 0),
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists members_gym_idx on members (gym_id);

create table if not exists payments (
  id serial primary key,
  gym_id int not null references gyms(id) on delete cascade,
  member_id int not null references members(id) on delete cascade,
  paid_on date not null,
  amount int not null check (amount >= 0),
  plan_name text not null,
  months int not null default 0,
  mode text not null default 'Cash',
  created_at timestamptz not null default now()
);
create index if not exists payments_member_idx on payments (member_id);
create index if not exists payments_gym_date_idx on payments (gym_id, paid_on);

create table if not exists checkins (
  id serial primary key,
  gym_id int not null references gyms(id) on delete cascade,
  member_id int not null references members(id) on delete cascade,
  at timestamptz not null default now(),
  day date not null
);
create unique index if not exists checkins_member_day on checkins (member_id, day);
create index if not exists checkins_gym_at_idx on checkins (gym_id, at);
