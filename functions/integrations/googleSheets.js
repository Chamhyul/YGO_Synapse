/**
 * Google Sheets API v4 Helper
 */
const { google } = require('googleapis');

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

/**
 * 시트 데이터 조회 (getValues)
 */
async function getSheetValues(spreadsheetId, range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return res.data.values || [];
}

/**
 * 시트 맨 아래에 데이터 추가 (append)
 */
async function appendSheetValues(spreadsheetId, range, values) {
  if (!values || values.length === 0) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

/**
 * 특정 범위의 데이터 업데이트 (update)
 */
async function updateSheetValues(spreadsheetId, range, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

/**
 * 대량 작업 (Batch Update) - 수량 업데이트 또는 행 삭제 등
 */
async function batchUpdateValues(spreadsheetId, data) {
  if (!data || data.length === 0) return;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });
}

/**
 * 행 삭제 (Batch Update - deleteDimension)
 */
async function deleteRows(spreadsheetId, sheetId, startIndex, endIndex) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex,
              endIndex,
            },
          },
        },
      ],
    },
  });
}

/**
 * 시트 정보 및 ID 조회
 */
async function getSpreadsheetMetadata(spreadsheetId) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
  });
  return res.data;
}

/**
 * 새 시트 추가 (addSheet)
 */
async function createSheet(spreadsheetId, title) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title,
            },
          },
        },
      ],
    },
  });
}

module.exports = {
  getSheetValues,
  appendSheetValues,
  updateSheetValues,
  batchUpdateValues,
  deleteRows,
  getSpreadsheetMetadata,
  createSheet,
};
