import { google } from "googleapis";

const scopes = ["https://www.googleapis.com/auth/spreadsheets"];

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  undefined,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  scopes
);

const sheets = google.sheets({ version: "v4", auth });

function spreadsheetId() {
  const id = process.env.SHEETS_SPREADSHEET_ID;
  if (!id) {
    throw new Error("SHEETS_SPREADSHEET_ID is not set");
  }
  return id;
}

function toColumnName(index: number) {
  if (index < 1) {
    throw new Error("Column index must be >= 1");
  }
  let columnName = "";
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    columnName = String.fromCharCode(65 + remainder) + columnName;
    current = Math.floor((current - 1) / 26);
  }
  return columnName;
}

export async function appendRow(sheetName: string, row: (string | number | null)[]) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

export async function getSheetValues(sheetName: string) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName}!A:Z`
  });
  return (res.data.values || []) as string[][];
}

export async function updateCell(
  sheetName: string,
  rowIndex: number,
  colIndex: number,
  value: string
) {
  const range = `${sheetName}!${toColumnName(colIndex)}${rowIndex}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] }
  });
}
