import urllib.request
import json
import time

url = "http://localhost:8787/stream/field"
print(f"Connecting to SSE stream at {url}...")

req = urllib.request.Request(url, headers={'Accept': 'text/event-stream'})

try:
    with urllib.request.urlopen(req, timeout=5) as response:
        frame_count = 0
        for line in response:
            line_str = line.decode('utf-8').strip()
            if line_str.startswith("data:"):
                data_json = line_str[5:].strip()
                frame = json.loads(data_json)
                frame_count += 1
                status = frame.get("status")
                timestamp = frame.get("timestamp")
                vectors = frame.get("vectors", [])
                
                print(f"\n[Frame {frame_count}] timestamp: {timestamp}, vectors: {len(vectors)}")
                print(f"  Raw status payload field: {status} (type: {type(status).__name__})")
                
                # Check for anomalies (if status is True or "anomaly" or "healed")
                if status is True or status == "healed" or status == "anomaly":
                    print("  Status Resolved: ANOMALY / HEALED (Calculations were sanitized)")
                else:
                    print("  Status Resolved: NOMINAL (Sanitation passed with zero mutations)")
                
                if frame_count >= 3:
                    break
except Exception as e:
    print(f"Error connecting to stream: {e}")
