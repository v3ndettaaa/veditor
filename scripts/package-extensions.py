#!/usr/bin/env python3
import os
import zipfile

def zip_dir(dir_path, output_zip):
    print(f"Packaging {dir_path} -> {output_zip}...")
    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(dir_path):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, dir_path)
                zipf.write(file_path, arcname)
    size_mb = os.path.getsize(output_zip) / (1024 * 1024)
    print(f"Created {output_zip} ({size_mb:.2f} MB)")

if __name__ == '__main__':
    os.makedirs('dist', exist_ok=True)
    if os.path.exists('dist/chrome'):
        zip_dir('dist/chrome', 'dist/veditor-chrome.zip')
    if os.path.exists('dist/firefox'):
        zip_dir('dist/firefox', 'dist/veditor-firefox.zip')
    print("Packaging complete!")
