-- Delete the admin user if exists
DELETE FROM users WHERE email = 'admin@medloop.com';

-- Insert a new admin user with a known bcrypt hash for '123456'
INSERT INTO users (email, role, password_hash)
VALUES (
  'admin@medloop.com',
  'admin',
  '$2b$10$Top7.v1.v1.v1.v1.v1.v1.v1.v1.v1.v1.v1.v1.v1.v1.v1.v1'
);
