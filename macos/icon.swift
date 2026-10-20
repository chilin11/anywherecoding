// Draws the AnywhereCoding app icon (web/public/icon.svg on the macOS icon grid) into an .iconset folder.
// Usage: swiftc -o icon macos/icon.swift && ./icon <out>.iconset && iconutil -c icns <out>.iconset
import AppKit

func color(_ hex: UInt32) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

func draw(pixels: Int) -> Data {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let unit = CGFloat(pixels) / 1024
  // SVG coordinates grow downwards.
  context.translateBy(x: 0, y: CGFloat(pixels))
  context.scaleBy(x: unit, y: -unit)

  // macOS grid: 824 pt body inside a 1024 canvas, continuous-looking corner radius, soft drop shadow.
  let body = CGRect(x: 100, y: 100, width: 824, height: 824)
  let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
  context.saveGState()
  // Shadow geometry ignores the CTM: device pixels, y up.
  context.setShadow(offset: CGSize(width: 0, height: -10 * unit), blur: 28 * unit, color: CGColor(gray: 0, alpha: 0.35))
  context.addPath(shape)
  context.setFillColor(color(0x18181b))
  context.fillPath()
  context.restoreGState()

  context.saveGState()
  context.addPath(shape)
  context.clip()
  let gradient = CGGradient(colorsSpace: space, colors: [color(0x2e2e33), color(0x141416)] as CFArray, locations: [0, 1])!
  context.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 100), end: CGPoint(x: 512, y: 924), options: [])
  context.restoreGState()

  // Hairline highlight on the top edge.
  context.saveGState()
  context.addPath(CGPath(roundedRect: body.insetBy(dx: 1.5, dy: 1.5), cornerWidth: 184, cornerHeight: 184, transform: nil))
  context.setStrokeColor(CGColor(gray: 1, alpha: 0.08))
  context.setLineWidth(3)
  context.strokePath()
  context.restoreGState()

  // "</>" from the 64-unit SVG, mapped onto the body.
  let scale = body.width / 64
  func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: body.minX + x * scale, y: body.minY + y * scale) }
  let glyph = CGMutablePath()
  glyph.move(to: point(20, 22)); glyph.addLine(to: point(12, 32)); glyph.addLine(to: point(20, 42))
  glyph.move(to: point(44, 22)); glyph.addLine(to: point(52, 32)); glyph.addLine(to: point(44, 42))
  glyph.move(to: point(36, 18)); glyph.addLine(to: point(28, 46))
  context.addPath(glyph)
  context.setStrokeColor(color(0xfafafa))
  context.setLineWidth(4.5 * scale)
  context.setLineCap(.round)
  context.setLineJoin(.round)
  context.strokePath()

  let image = context.makeImage()!
  return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!
}

let output = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
  try draw(pixels: size).write(to: output.appendingPathComponent("icon_\(size)x\(size).png"))
  try draw(pixels: size * 2).write(to: output.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
