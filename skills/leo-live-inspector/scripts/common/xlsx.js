import { spawnSync } from 'node:child_process';

const PYTHON_CODE = `
import sys, base64, io, zipfile, json
import xml.etree.ElementTree as ET

try:
    b64_str = sys.stdin.read().strip()
    zf = zipfile.ZipFile(io.BytesIO(base64.b64decode(b64_str)))
    shared_strings = []
    if 'xl/sharedStrings.xml' in zf.namelist():
        tree = ET.fromstring(zf.read('xl/sharedStrings.xml'))
        for si in tree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
            t = si.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t')
            shared_strings.append(t.text if t is not None and t.text else '')

    tree = ET.fromstring(zf.read('xl/worksheets/sheet1.xml'))
    rows = []
    for r in tree.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row'):
        row_vals = []
        for c in r.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c'):
            t_type = c.get('t')
            v = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
            val = v.text if v is not None else ''
            if t_type == 's' and val.isdigit():
                idx = int(val)
                val = shared_strings[idx] if idx < len(shared_strings) else val
            row_vals.append(val)
        if any(row_vals):
            rows.append(row_vals)
    print(json.dumps(rows, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

export function runPythonCode(input, candidates = ['python3', 'python']) {
  const errors = [];

  for (const command of candidates) {
    const child = spawnSync(command, ['-c', PYTHON_CODE], {
      input,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    });

    if (!child.error) return child;
    errors.push(`${command}: ${child.error.message}`);
  }

  return { error: new Error(errors.join('; ')) };
}

export function parseXlsxBase64WithPython(b64Data, candidates = ['python3', 'python']) {
  const child = runPythonCode(b64Data, candidates);

  if (child.error) {
    return { error: child.error.message };
  }

  try {
    return JSON.parse(child.stdout);
  } catch {
    return { error: `Failed to parse python json output: ${child.stdout}` };
  }
}
