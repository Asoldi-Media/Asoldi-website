export function parseEmailAddress(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  const angled = raw.match(/<([^>]+)>/);
  const email = (angled ? angled[1] : raw).replace(/^mailto:/, '').trim();
  return /@/.test(email) ? email : '';
}

export function digitsOnly(value = '') {
  return String(value || '').replace(/\D+/g, '');
}

function nameKey(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9æøåäöü]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function matchSalesClient(clients = [], { from = '', match = {} } = {}) {
  const list = Array.isArray(clients) ? clients : [];
  const fromEmail = parseEmailAddress(from);
  const org = digitsOnly(match.orgNumber).slice(0, 9);
  const business = nameKey(match.businessName);
  const hintEmail = parseEmailAddress(match.email);

  const emailHit = list.find((client) => {
    const emails = [client.clientEmail, client.contactEmail, client.websiteEmail]
      .map((entry) => parseEmailAddress(entry))
      .filter(Boolean);
    return (fromEmail && emails.includes(fromEmail)) || (hintEmail && emails.includes(hintEmail));
  });
  if (emailHit) return { client: emailHit, via: 'email' };

  if (org.length === 9) {
    const orgHit = list.find((client) => digitsOnly(client.orgNumber) === org);
    if (orgHit) return { client: orgHit, via: 'org' };
  }

  if (business.length > 3) {
    const nameHit = list.find((client) => {
      const name = nameKey(client.businessName);
      return name && (name.includes(business) || business.includes(name));
    });
    if (nameHit) return { client: nameHit, via: 'name' };
  }

  return { client: null, via: '' };
}
