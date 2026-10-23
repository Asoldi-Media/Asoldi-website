import { guardExternal } from './safe-mode.js';

const LUCA_API_URL = 'https://go.lucaregnskap.no/api/v1/graphql';

/** GraphQL documents that are not plain queries (mutation, subscription, anything unknown). */
export function lucaDocumentWrites(query = '') {
  const text = String(query || '').replace(/#[^\n]*/g, '').trim();
  return !/^(query\b|\{)/i.test(text);
}

function getLucaApiKey() {
  return String(process.env.LUCA_API_KEY || '').trim();
}

async function lucaQuery(query, variables = {}) {
  const apiKey = getLucaApiKey();
  if (!apiKey) return { success: false, error: 'LUCA_API_KEY not configured' };
  if (lucaDocumentWrites(query) && !guardExternal('accountingWrite', 'Luca GraphQL mutation').allowed) {
    return { success: false, error: 'Blocked by hub safe mode (accountingWrite).', safeMode: true };
  }

  try {
    const response = await fetch(LUCA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const result = await response.json();
    if (result.errors?.length) {
      return { success: false, error: result.errors[0]?.message || 'GraphQL error' };
    }

    return { success: true, data: result.data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown Luca error' };
  }
}

export async function testLucaConnection() {
  const response = await lucaQuery(`
    query TestConnection {
      saleInvoices(first: 1) {
        nodes { id }
      }
    }
  `);
  return { connected: !!response.success, error: response.success ? '' : response.error || '' };
}

export async function getIncomeSummary() {
  const response = await lucaQuery(`
    query GetIncomeSummary {
      saleInvoices(first: 500) {
        nodes {
          totalIncVat
          paidAmount
          status
          createdAt
          invoiceNumber
          dueDate
          paidAt
          customer { id name }
        }
      }
    }
  `);

  if (!response.success) return response;

  const invoices = (response.data?.saleInvoices?.nodes || []).map((invoice) => ({
    id: invoice.id || invoice.invoiceNumber,
    invoiceNumber: invoice.invoiceNumber,
    customerName: invoice.customer?.name || 'Unknown',
    customerId: invoice.customer?.id || '',
    totalAmount: Number(invoice.totalIncVat || 0),
    paidAmount: Number(invoice.paidAmount || 0),
    status: invoice.status || '',
    dueDate: invoice.dueDate || '',
    paidDate: invoice.paidAt || '',
    createdAt: invoice.createdAt || '',
  }));

  const summary = {
    totalRevenue: invoices.reduce((sum, invoice) => sum + invoice.paidAmount, 0),
    paidInvoices: invoices.filter((invoice) => invoice.paidAmount >= invoice.totalAmount).length,
    unpaidInvoices: invoices.filter((invoice) => invoice.paidAmount < invoice.totalAmount).length,
    pendingAmount: invoices.reduce((sum, invoice) => sum + Math.max(0, invoice.totalAmount - invoice.paidAmount), 0),
  };

  return { success: true, invoices, summary };
}

export async function getCustomersWithRevenue() {
  const response = await lucaQuery(`
    query GetCustomersWithRevenue {
      customers(first: 100) {
        nodes {
          id
          name
          email
          phone
          organizationNumber
        }
      }
      saleInvoices(first: 500) {
        nodes {
          customer { id }
          paidAmount
        }
      }
    }
  `);

  if (!response.success) return response;

  const totals = new Map();
  for (const invoice of response.data?.saleInvoices?.nodes || []) {
    const customerId = invoice.customer?.id;
    if (!customerId) continue;
    const current = totals.get(customerId) || { totalRevenue: 0, invoiceCount: 0 };
    current.totalRevenue += Number(invoice.paidAmount || 0);
    current.invoiceCount += 1;
    totals.set(customerId, current);
  }

  const customers = (response.data?.customers?.nodes || []).map((customer) => {
    const revenue = totals.get(customer.id) || { totalRevenue: 0, invoiceCount: 0 };
    return {
      id: customer.id,
      name: customer.name,
      email: customer.email || '',
      phone: customer.phone || '',
      organizationNumber: customer.organizationNumber || '',
      totalRevenue: revenue.totalRevenue,
      invoiceCount: revenue.invoiceCount,
    };
  }).sort((a, b) => b.totalRevenue - a.totalRevenue);

  return { success: true, customers };
}
