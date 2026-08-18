-- Initial migration: create all tables, indexes, constraints, and RLS policies
-- Generated manually to match 07-postgresql-design.md

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- tenants
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  max_users INT NOT NULL DEFAULT 5,
  license_key VARCHAR(255),
  license_expires_at TIMESTAMPTZ,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(320) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'accountant', 'warehouse', 'viewer')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  permissions JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'users'
  ) THEN
    CREATE POLICY tenant_isolation ON users FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- parties
CREATE TABLE IF NOT EXISTS parties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('customer', 'supplier')),
  code VARCHAR(50),
  name VARCHAR(255) NOT NULL,
  company_name VARCHAR(255),
  commercial_reg VARCHAR(100),
  category VARCHAR(100),
  sales_rep VARCHAR(100),
  phone VARCHAR(30),
  mobile VARCHAR(30),
  whatsapp VARCHAR(30),
  alt_phone VARCHAR(30),
  email VARCHAR(320),
  website VARCHAR(500),
  address TEXT,
  city VARCHAR(100),
  country VARCHAR(100),
  tax_number VARCHAR(100),
  opening_balance BIGINT NOT NULL DEFAULT 0,
  credit_limit BIGINT DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  payment_terms VARCHAR(20),
  payment_method VARCHAR(20),
  default_discount DECIMAL(5,4) DEFAULT 0,
  vat DECIMAL(5,4) DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'cancelled')),
  notes TEXT,
  attachments JSONB DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, name)
);

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'parties'
  ) THEN
    CREATE POLICY tenant_isolation ON parties FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- fabrics
CREATE TABLE IF NOT EXISTS fabrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  min_stock_kg DECIMAL(12,2) DEFAULT 0,
  unit VARCHAR(10) CHECK (unit IN ('meter', 'yard', 'kg')),
  notes TEXT,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

ALTER TABLE fabrics ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'fabrics'
  ) THEN
    CREATE POLICY tenant_isolation ON fabrics FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- colors
CREATE TABLE IF NOT EXISTS colors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  fabric_id UUID NOT NULL REFERENCES fabrics(id),
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, fabric_id, name)
);

ALTER TABLE colors ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'colors'
  ) THEN
    CREATE POLICY tenant_isolation ON colors FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- rolls
CREATE TABLE IF NOT EXISTS rolls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  color_id UUID NOT NULL REFERENCES colors(id),
  roll_no VARCHAR(100) NOT NULL,
  dye_batch VARCHAR(100),
  initial_kg DECIMAL(12,2) NOT NULL,
  remaining_kg DECIMAL(12,2) NOT NULL,
  price_per_kg DECIMAL(12,2) NOT NULL,
  sale_price_per_kg DECIMAL(12,2),
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  supplier_id UUID REFERENCES parties(id),
  entry_date DATE NOT NULL,
  width_cm DECIMAL(7,2),
  weight_gsm DECIMAL(7,2),
  status VARCHAR(20) NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'exhausted', 'reserved')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, roll_no)
);

ALTER TABLE rolls ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'rolls'
  ) THEN
    CREATE POLICY tenant_isolation ON rolls FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rolls_color ON rolls(color_id);
CREATE INDEX IF NOT EXISTS idx_rolls_status ON rolls(tenant_id, status);

-- invoices
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  number VARCHAR(50) NOT NULL,
  type VARCHAR(10) NOT NULL CHECK (type IN ('entry', 'sale')),
  date DATE NOT NULL,
  party_id UUID NOT NULL REFERENCES parties(id),
  party_type VARCHAR(10) NOT NULL CHECK (party_type IN ('customer', 'supplier')),
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  subtotal BIGINT NOT NULL DEFAULT 0,
  discount BIGINT NOT NULL DEFAULT 0,
  tax BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  cancellation_reference_id UUID,
  UNIQUE (tenant_id, type, number)
);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'invoices'
  ) THEN
    CREATE POLICY tenant_isolation ON invoices FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_party ON invoices(tenant_id, party_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(tenant_id, date);

-- invoice_lines
CREATE TABLE IF NOT EXISTS invoice_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  fabric_id UUID NOT NULL REFERENCES fabrics(id),
  color_id UUID NOT NULL REFERENCES colors(id),
  roll_id UUID NOT NULL REFERENCES rolls(id),
  quantity_kg DECIMAL(12,2) NOT NULL,
  price_per_kg DECIMAL(12,2) NOT NULL,
  discount_percent DECIMAL(5,4) NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'invoice_lines'
  ) THEN
    CREATE POLICY tenant_isolation ON invoice_lines FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;
-- orders
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  code VARCHAR(50) NOT NULL,
  customer_id UUID REFERENCES parties(id),
  customer_name_snapshot VARCHAR(255) NOT NULL,
  customer_phone_snapshot VARCHAR(30),
  date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'partially_available', 'available', 'fulfilled', 'cancelled')),
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  notes TEXT,
  fulfilled_invoice_id UUID REFERENCES invoices(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'orders'
  ) THEN
    CREATE POLICY tenant_isolation ON orders FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- order_items
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  fabric_id UUID REFERENCES fabrics(id),
  fabric_name VARCHAR(255) NOT NULL,
  color_id UUID REFERENCES colors(id),
  color_name VARCHAR(255) NOT NULL,
  color_code VARCHAR(50),
  requested_kg DECIMAL(12,2) NOT NULL,
  width_cm DECIMAL(7,2),
  weight_gsm DECIMAL(7,2),
  notes TEXT
);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'order_items'
  ) THEN
    CREATE POLICY tenant_isolation ON order_items FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;
-- vouchers
CREATE TABLE IF NOT EXISTS vouchers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('receipt', 'payment')),
  number VARCHAR(50) NOT NULL,
  date DATE NOT NULL,
  party_id UUID NOT NULL REFERENCES parties(id),
  party_kind VARCHAR(10) NOT NULL CHECK (party_kind IN ('customer', 'supplier')),
  invoice_id UUID REFERENCES invoices(id),
  amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  method VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'transfer', 'check', 'card')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  notes_print TEXT,
  notes_internal TEXT,
  attachments JSONB DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  UNIQUE (tenant_id, kind, number)
);

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'vouchers'
  ) THEN
    CREATE POLICY tenant_isolation ON vouchers FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vouchers_party ON vouchers(tenant_id, party_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_invoice ON vouchers(tenant_id, invoice_id);

-- ledger_entries
CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  party_id UUID NOT NULL REFERENCES parties(id),
  date DATE NOT NULL,
  type VARCHAR(30) NOT NULL
    CHECK (type IN ('opening', 'purchase_invoice', 'sales_invoice', 'payment_out',
                    'receipt_in', 'purchase_return', 'sales_return', 'expense',
                    'adjustment', 'cancellation')),
  debit BIGINT DEFAULT 0,
  credit BIGINT DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  cash_impact VARCHAR(10) NOT NULL DEFAULT 'none'
    CHECK (cash_impact IN ('in', 'out', 'none')),
  reference_type VARCHAR(50),
  reference_id UUID,
  reference_number VARCHAR(100),
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  cancellation_reference_id UUID,
  CONSTRAINT ledger_debit_credit_check CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  )
);

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'ledger_entries'
  ) THEN
    CREATE POLICY tenant_isolation ON ledger_entries FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ledger_party ON ledger_entries(tenant_id, party_id);
CREATE INDEX IF NOT EXISTS idx_ledger_reference ON ledger_entries(tenant_id, reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_entries(tenant_id, date);

-- cashbox_sessions
CREATE TABLE IF NOT EXISTS cashbox_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  opening_balance BIGINT NOT NULL DEFAULT 0,
  opening_date DATE NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cashbox_sessions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'cashbox_sessions'
  ) THEN
    CREATE POLICY tenant_isolation ON cashbox_sessions FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- manual_movements
CREATE TABLE IF NOT EXISTS manual_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  date DATE NOT NULL,
  type VARCHAR(20) NOT NULL
    CHECK (type IN ('capital', 'withdrawal', 'transfer', 'adjustment', 'correction')),
  direction VARCHAR(5) NOT NULL CHECK (direction IN ('in', 'out')),
  amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  description TEXT,
  notes_internal TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

ALTER TABLE manual_movements ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'manual_movements'
  ) THEN
    CREATE POLICY tenant_isolation ON manual_movements FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- day_closes
CREATE TABLE IF NOT EXISTS day_closes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  date DATE NOT NULL,
  opening_balance BIGINT NOT NULL,
  total_in BIGINT NOT NULL,
  total_out BIGINT NOT NULL,
  expected BIGINT NOT NULL,
  counted BIGINT NOT NULL,
  difference BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by UUID,
  UNIQUE (tenant_id, date)
);

ALTER TABLE day_closes ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'day_closes'
  ) THEN
    CREATE POLICY tenant_isolation ON day_closes FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- expenses
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  number VARCHAR(50) NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  amount BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP' CHECK (currency IN ('SYP', 'USD', 'EUR')),
  date DATE NOT NULL,
  method VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'transfer', 'check', 'card')),
  paid_from_cashbox BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  notes_print TEXT,
  notes_internal TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  UNIQUE (tenant_id, number)
);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'expenses'
  ) THEN
    CREATE POLICY tenant_isolation ON expenses FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- returns
CREATE TABLE IF NOT EXISTS returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  number VARCHAR(50) NOT NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('entry', 'sale')),
  date DATE NOT NULL,
  party_id UUID NOT NULL REFERENCES parties(id),
  original_invoice_id UUID REFERENCES invoices(id),
  reason VARCHAR(20) NOT NULL CHECK (reason IN ('defect', 'wrong_quantity', 'wrong_order', 'other')),
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP',
  notes_print TEXT,
  notes_internal TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID,
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID,
  UNIQUE (tenant_id, kind, number)
);

ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'returns'
  ) THEN
    CREATE POLICY tenant_isolation ON returns FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- return_lines
CREATE TABLE IF NOT EXISTS return_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  return_id UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  roll_id UUID NOT NULL REFERENCES rolls(id),
  quantity_kg DECIMAL(12,2) NOT NULL,
  price_per_kg DECIMAL(12,2) NOT NULL
);

ALTER TABLE return_lines ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'return_lines'
  ) THEN
    CREATE POLICY tenant_isolation ON return_lines FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;
-- print_jobs
CREATE TABLE IF NOT EXISTS print_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  date DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'received')),
  source_roll_id UUID NOT NULL REFERENCES rolls(id),
  source_fabric_id UUID,
  source_color_id UUID,
  quantity_kg DECIMAL(12,2) NOT NULL,
  press_name VARCHAR(255),
  print_cost_per_kg DECIMAL(12,2),
  currency VARCHAR(3) NOT NULL DEFAULT 'SYP',
  new_name VARCHAR(255),
  new_category VARCHAR(100),
  new_color_name VARCHAR(255),
  new_color_code VARCHAR(50),
  new_sale_price_per_kg DECIMAL(12,2),
  received_kg DECIMAL(12,2),
  result_roll_id UUID REFERENCES rolls(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'print_jobs'
  ) THEN
    CREATE POLICY tenant_isolation ON print_jobs FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- document_sequences
CREATE TABLE IF NOT EXISTS document_sequences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  prefix VARCHAR(10),
  last_number BIGINT NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, entity_type, prefix)
);

ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'document_sequences'
  ) THEN
    CREATE POLICY tenant_isolation ON document_sequences FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  actor_id UUID,
  actor_name VARCHAR(255),
  module VARCHAR(50) NOT NULL,
  action VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50),
  entity_id UUID,
  detail TEXT,
  before_snapshot JSONB,
  after_snapshot JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'audit_logs'
  ) THEN
    CREATE POLICY tenant_isolation ON audit_logs FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  user_id UUID REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  detail TEXT,
  kind VARCHAR(20) NOT NULL
    CHECK (kind IN ('credit', 'aging', 'stock', 'unpaid', 'cash', 'order')),
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  target_path VARCHAR(500),
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  is_dismissed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'notifications'
  ) THEN
    CREATE POLICY tenant_isolation ON notifications FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- settings
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID UNIQUE NOT NULL,
  company JSONB DEFAULT '{}',
  currencies JSONB DEFAULT '[]',
  payment_methods JSONB DEFAULT '[]',
  taxes JSONB DEFAULT '[]',
  units JSONB DEFAULT '[]',
  warehouses JSONB DEFAULT '[]',
  printing JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'settings'
  ) THEN
    CREATE POLICY tenant_isolation ON settings FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;

-- attachments
CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  filename VARCHAR(500) NOT NULL,
  mime_type VARCHAR(255),
  size_bytes BIGINT,
  storage_key VARCHAR(500) NOT NULL,
  storage_url TEXT,
  uploaded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'tenant_isolation' AND c.relname = 'attachments'
  ) THEN
    CREATE POLICY tenant_isolation ON attachments FOR ALL
      USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
  END IF;
END $$;
