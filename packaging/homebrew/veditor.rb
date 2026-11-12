cask "veditor" do
  arch arm: "aarch64", intel: "x64"

  version "4.0.0"
  sha256 :no_check

  url "https://github.com/v3ndettaaa/veditor/releases/download/v#{version}/veditor_#{version}_#{arch}.dmg"
  name "veditor"
  desc "Native-grade desktop PDF editor and annotation workspace"
  homepage "https://github.com/v3ndettaaa/veditor"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "veditor.app"

  zap trash: [
    "~/Library/Application Support/com.v3ndettaaa.veditor",
    "~/Library/Caches/com.v3ndettaaa.veditor",
    "~/Library/Preferences/com.v3ndettaaa.veditor.plist",
    "~/Library/Saved Application State/com.v3ndettaaa.veditor.savedState",
  ]
end
