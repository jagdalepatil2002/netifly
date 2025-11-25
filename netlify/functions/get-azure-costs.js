/**
 * Azure Cost Tracking Netlify Function
 * HTTP triggered function to retrieve Azure cost data for specified date ranges
 * 
 * Deploy to: netlify/functions/get-azure-costs.js
 */

const axios = require('axios');

/**
 * Main handler function
 */
exports.handler = async (event, context) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  console.log('Azure Cost Tracking function received a request');

  try {
    // Parse request parameters
    const params = getRequestParameters(event);
    
    // Validate parameters
    const validationError = validateParameters(params);
    if (validationError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: validationError })
      };
    }

    // Authenticate with Azure
    const token = await authenticateAzure();

    // Fetch cost data
    const costData = await fetchCostData(
      token,
      params.subscription_id,
      params.start_date,
      params.end_date,
      params.granularity,
      params.start_time,
      params.end_time
    );

    // Fetch resource tags if requested
    let resourceTags = {};
    if (params.include_tags) {
      resourceTags = await fetchResourceTags(token, params.subscription_id);
    }

    // Process and format data
    const result = processCostData(costData, resourceTags, params);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result, null, 2)
    };

  } catch (error) {
    console.error('Error processing request:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};

/**
 * Extract and parse request parameters
 */
function getRequestParameters(event) {
  let body = {};
  
  // Parse body if present
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      body = {};
    }
  }

  // Get query parameters
  const queryParams = event.queryStringParameters || {};

  // Extract parameters (body takes precedence over query params)
  const start_date = body.start_date || queryParams.start_date;
  const end_date = body.end_date || queryParams.end_date;
  const start_time = body.start_time || queryParams.start_time || '00:00:00';
  const end_time = body.end_time || queryParams.end_time || '23:59:59';
  const subscription_id = body.subscription_id || queryParams.subscription_id || process.env.AZURE_SUBSCRIPTION_ID;
  
  // include_tags is True by default
  let include_tags = true;
  if (body.hasOwnProperty('include_tags')) {
    include_tags = body.include_tags === true || body.include_tags === 'true';
  } else if (queryParams.include_tags) {
    include_tags = queryParams.include_tags === 'true';
  }

  const granularity = body.granularity || queryParams.granularity || 'Daily';

  return {
    start_date,
    end_date,
    start_time,
    end_time,
    subscription_id,
    include_tags,
    granularity
  };
}

/**
 * Validate request parameters
 */
function validateParameters(params) {
  if (!params.start_date) {
    return 'Missing required parameter: start_date (format: YYYY-MM-DD)';
  }

  if (!params.end_date) {
    return 'Missing required parameter: end_date (format: YYYY-MM-DD)';
  }

  if (!params.subscription_id) {
    return 'Missing required parameter: subscription_id';
  }

  // Validate date format and range
  try {
    const start = new Date(params.start_date);
    const end = new Date(params.end_date);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return 'Invalid date format. Use YYYY-MM-DD';
    }

    if (end < start) {
      return 'end_date must be greater than or equal to start_date';
    }

    // Check date range (max 1 year)
    const daysDiff = Math.floor((end - start) / (1000 * 60 * 60 * 24));
    if (daysDiff > 365) {
      return 'Date range cannot exceed 365 days';
    }

  } catch (error) {
    return 'Invalid date format. Use YYYY-MM-DD';
  }

  // Validate time format (HH:MM:SS)
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
  if (!timeRegex.test(params.start_time) || !timeRegex.test(params.end_time)) {
    return 'Invalid time format. Use HH:MM:SS (e.g., 14:30:00)';
  }

  // Validate granularity
  if (!['Daily', 'Monthly'].includes(params.granularity)) {
    return "granularity must be 'Daily' or 'Monthly'";
  }

  return null;
}

/**
 * Authenticate with Azure and return access token
 */
async function authenticateAzure() {
  console.log('Authenticating with Azure...');

  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;

  if (!clientId || !clientSecret || !tenantId) {
    throw new Error('Missing Azure credentials in environment variables');
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'https://management.azure.com/.default',
    client_secret: clientSecret,
    grant_type: 'client_credentials'
  });

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  console.log('Authentication successful');
  return response.data.access_token;
}

/**
 * Fetch cost data from Azure Cost Management API
 */
async function fetchCostData(token, subscriptionId, startDate, endDate, granularity, startTime = '00:00:00', endTime = '23:59:59') {
  console.log(`Fetching cost data from ${startDate} ${startTime} to ${endDate} ${endTime}`);

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const costQuery = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: {
      from: `${startDate}T${startTime}Z`,
      to: `${endDate}T${endTime}Z`
    },
    dataset: {
      granularity: granularity,
      aggregation: {
        totalCost: {
          name: 'PreTaxCost',
          function: 'Sum'
        }
      },
      grouping: [
        { type: 'Dimension', name: 'ServiceName' },
        { type: 'Dimension', name: 'ResourceId' },
        { type: 'Dimension', name: 'ResourceGroupName' },
        { type: 'Dimension', name: 'ResourceType' }
      ]
    }
  };

  const url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`;

  const response = await axios.post(url, costQuery, { headers });

  console.log('Cost data retrieved successfully');
  return response.data;
}

/**
 * Fetch resource tags using Azure Resource Graph
 */
async function fetchResourceTags(token, subscriptionId) {
  console.log('Fetching resource tags...');

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const query = {
    query: `Resources | where subscriptionId == '${subscriptionId}' | project id, tags`
  };

  const url = 'https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01';

  try {
    const response = await axios.post(url, query, { headers });
    const data = response.data;

    console.log(`Found ${data.data.length} resources`);

    // Build tags dictionary
    const resourceTags = {};
    for (const resource of data.data) {
      const resourceId = resource.id;
      if (resource.tags && Object.keys(resource.tags).length > 0) {
        resourceTags[resourceId] = resource.tags;
      } else {
        resourceTags[resourceId] = {};
      }
    }

    return resourceTags;

  } catch (error) {
    console.warn(`Failed to fetch tags: ${error.message}`);
    return {};
  }
}

/**
 * Process cost data and format response
 */
function processCostData(costResponse, resourceTags, params) {
  const columns = costResponse.properties.columns;
  const rows = costResponse.properties.rows;

  // Build column map
  const columnMap = {};
  columns.forEach((col, idx) => {
    columnMap[col.name] = idx;
  });

  console.log(`Processing ${rows.length} records`);

  const detailedCosts = [];
  let totalCost = 0;

  for (const row of rows) {
    // Parse date
    let dateValue = 'Unknown';
    if (columnMap.hasOwnProperty('UsageDate')) {
      try {
        const dateStr = String(row[columnMap.UsageDate]);
        const year = dateStr.substring(0, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);
        dateValue = `${day}-${month}-${year}`;
      } catch (error) {
        dateValue = 'Unknown';
      }
    }

    const resourceId = columnMap.hasOwnProperty('ResourceId') ? row[columnMap.ResourceId] : '';

    // Extract resource name
    let resourceName = 'N/A';
    if (resourceId) {
      const parts = resourceId.split('/');
      if (parts.length > 0) {
        resourceName = parts[parts.length - 1];
      }
    }

    // Get tags - format as string like "ENV=PRD; Team=Engineering"
    let tagsStr = 'No tags';
    if (resourceId && params.include_tags) {
      const tagsDict = resourceTags[resourceId] || {};
      if (Object.keys(tagsDict).length > 0) {
        tagsStr = Object.entries(tagsDict)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
      }
    }

    const cost = Math.round(row[columnMap.PreTaxCost] * 100) / 100;
    totalCost += cost;

    const costItem = {
      Date: dateValue,
      Cost_INR: cost,
      ServiceName: columnMap.hasOwnProperty('ServiceName') ? row[columnMap.ServiceName] : 'N/A',
      ResourceName: resourceName,
      ResourceId: resourceId,
      ResourceGroupName: columnMap.hasOwnProperty('ResourceGroupName') ? row[columnMap.ResourceGroupName] : 'N/A',
      ResourceType: columnMap.hasOwnProperty('ResourceType') ? row[columnMap.ResourceType] : 'N/A',
      Tags: tagsStr
    };

    detailedCosts.push(costItem);
  }

  // Sort by date and cost (descending within each date)
  detailedCosts.sort((a, b) => {
    if (a.Date !== b.Date) {
      return a.Date.localeCompare(b.Date);
    }
    return b.Cost_INR - a.Cost_INR;
  });

  // Create summary statistics
  const summary = createSummary(detailedCosts, totalCost, params);

  return {
    summary,
    detailed_costs: detailedCosts,
    metadata: {
      start_date: params.start_date,
      end_date: params.end_date,
      start_time: params.start_time,
      end_time: params.end_time,
      subscription_id: params.subscription_id,
      granularity: params.granularity,
      total_records: detailedCosts.length,
      generated_at: new Date().toISOString()
    }
  };
}

/**
 * Create summary statistics from detailed cost data
 */
function createSummary(detailedCosts, totalCost, params) {
  if (detailedCosts.length === 0) {
    return {
      total_cost: 0,
      currency: 'INR',
      average_daily_cost: 0,
      unique_services: 0,
      unique_resources: 0,
      unique_resource_groups: 0,
      top_services: [],
      top_resources: [],
      daily_breakdown: []
    };
  }

  // Calculate date range
  const start = new Date(params.start_date);
  const end = new Date(params.end_date);
  const days = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;

  // Get unique counts
  const uniqueServices = new Set(
    detailedCosts
      .filter(item => item.ServiceName !== 'N/A')
      .map(item => item.ServiceName)
  ).size;

  const uniqueResources = new Set(
    detailedCosts
      .filter(item => item.ResourceId)
      .map(item => item.ResourceId)
  ).size;

  const uniqueResourceGroups = new Set(
    detailedCosts
      .filter(item => item.ResourceGroupName !== 'N/A')
      .map(item => item.ResourceGroupName)
  ).size;

  // Top 5 services by cost
  const serviceCosts = {};
  for (const item of detailedCosts) {
    if (item.ServiceName !== 'N/A') {
      serviceCosts[item.ServiceName] = (serviceCosts[item.ServiceName] || 0) + item.Cost_INR;
    }
  }

  const topServices = Object.entries(serviceCosts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([service, cost]) => ({
      service,
      cost: Math.round(cost * 100) / 100
    }));

  // Top 10 resources by cost
  const resourceCosts = {};
  for (const item of detailedCosts) {
    if (item.ResourceName !== 'N/A') {
      const key = `${item.ResourceName} (${item.ServiceName})`;
      resourceCosts[key] = (resourceCosts[key] || 0) + item.Cost_INR;
    }
  }

  const topResources = Object.entries(resourceCosts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([resource, cost]) => ({
      resource,
      cost: Math.round(cost * 100) / 100
    }));

  // Daily breakdown
  const dailyCosts = {};
  for (const item of detailedCosts) {
    const date = item.Date;
    dailyCosts[date] = (dailyCosts[date] || 0) + item.Cost_INR;
  }

  const dailyBreakdown = Object.entries(dailyCosts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, cost]) => ({
      date,
      cost: Math.round(cost * 100) / 100
    }));

  return {
    total_cost: Math.round(totalCost * 100) / 100,
    currency: 'INR',
    average_daily_cost: days > 0 ? Math.round((totalCost / days) * 100) / 100 : 0,
    unique_services: uniqueServices,
    unique_resources: uniqueResources,
    unique_resource_groups: uniqueResourceGroups,
    top_services: topServices,
    top_resources: topResources,
    daily_breakdown: dailyBreakdown
  };
}
