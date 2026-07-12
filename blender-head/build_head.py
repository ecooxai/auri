"""Procedural 3D head built from scratch, matched to reference photo.

Approach: overlapping ellipsoid volumes -> voxel remesh union -> smooth.
Face points toward -Y. Z up. Head ~2.3 units tall, centered near eye level.
Run: blender --background --python build_head.py
"""
import bpy
import bmesh
import math
import os
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
RENDER_DIR = os.path.join(HERE, "renders")
BLEND_PATH = os.path.join(HERE, "head.blend")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

def set_in(node, names, value):
    if isinstance(names, str):
        names = [names]
    for n in names:
        if n in node.inputs:
            node.inputs[n].default_value = value
            return True
    return False


def make_simple_mat(name, color, rough=0.5, sss=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    set_in(bsdf, "Base Color", (*color, 1.0))
    set_in(bsdf, "Roughness", rough)
    if sss > 0:
        set_in(bsdf, ["Subsurface Weight", "Subsurface"], sss)
        set_in(bsdf, "Subsurface Radius", (0.15, 0.05, 0.03))
    return mat


def link_obj(obj):
    scene.collection.objects.link(obj)


def shade_smooth(mesh):
    for p in mesh.polygons:
        p.use_smooth = True


def add_sphere(name, mat, loc, scale, rot=(0, 0, 0), segs=32, rings=16):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    obj.scale = scale
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    link_obj(obj)
    shade_smooth(mesh)
    return obj


def make_tube(name, mat, points, radius, closed=True, ref_dir=Vector((0, -1, 0)),
              rsides=8):
    """Loft a tube of given radius along a list of Vector points."""
    n = len(points)
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(points):
        nxt = points[(i + 1) % n]
        prv = points[(i - 1) % n]
        t = (nxt - prv)
        if t.length < 1e-9:
            t = Vector((1, 0, 0))
        t.normalize()
        n1 = t.cross(ref_dir)
        if n1.length < 1e-6:
            n1 = t.cross(Vector((0, 0, 1)))
        n1.normalize()
        n2 = t.cross(n1).normalized()
        ring = []
        for k in range(rsides):
            a = 2 * math.pi * k / rsides
            ring.append(bm.verts.new(p + radius * (math.cos(a) * n1 + math.sin(a) * n2)))
        rings.append(ring)
    m = n if closed else n - 1
    for i in range(m):
        r0, r1 = rings[i], rings[(i + 1) % n]
        for k in range(rsides):
            bm.faces.new([r0[k], r0[(k + 1) % rsides],
                          r1[(k + 1) % rsides], r1[k]])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    link_obj(obj)
    shade_smooth(mesh)
    return obj

# ----------------------------------------------------------------------------
# Materials
# ----------------------------------------------------------------------------
SKIN_COL = (0.50, 0.30, 0.18, 1.0)
STUBBLE_COL = (0.15, 0.09, 0.07, 1.0)
LIP_COL = (0.48, 0.22, 0.17, 1.0)

skin_mat = bpy.data.materials.new("Skin")
skin_mat.use_nodes = True
nt = skin_mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
set_in(bsdf, "Roughness", 0.48)
set_in(bsdf, ["Subsurface Weight", "Subsurface"], 0.10)
set_in(bsdf, "Subsurface Radius", (0.15, 0.05, 0.03))

# stubble: attribute * noise -> darken; lips: attribute -> lip color
attr_st = nt.nodes.new("ShaderNodeAttribute")
attr_st.attribute_name = "stubble"
attr_lip = nt.nodes.new("ShaderNodeAttribute")
attr_lip.attribute_name = "lipmask"
noise = nt.nodes.new("ShaderNodeTexNoise")
set_in(noise, "Scale", 55.0)
set_in(noise, "Detail", 6.0)
nmap = nt.nodes.new("ShaderNodeMapRange")
set_in(nmap, "From Min", 0.45)
set_in(nmap, "From Max", 0.80)
mult = nt.nodes.new("ShaderNodeMath")
mult.operation = "MULTIPLY"
mult.use_clamp = True
mix_st = nt.nodes.new("ShaderNodeMix")
mix_st.data_type = "RGBA"
mix_st.inputs["A"].default_value = SKIN_COL
mix_st.inputs["B"].default_value = STUBBLE_COL
mix_lip = nt.nodes.new("ShaderNodeMix")
mix_lip.data_type = "RGBA"
mix_lip.inputs["B"].default_value = LIP_COL
nt.links.new(noise.outputs["Fac"], nmap.inputs["Value"])
nt.links.new(attr_st.outputs["Fac"], mult.inputs[0])
nt.links.new(nmap.outputs["Result"], mult.inputs[1])
nt.links.new(mult.outputs["Value"], mix_st.inputs["Factor"])
nt.links.new(mix_st.outputs["Result"], mix_lip.inputs["A"])
nt.links.new(attr_lip.outputs["Fac"], mix_lip.inputs["Factor"])
nt.links.new(mix_lip.outputs["Result"], bsdf.inputs["Base Color"])

hair_mat = make_simple_mat("Hair", (0.025, 0.018, 0.013), rough=0.6)
brow_mat = make_simple_mat("Brow", (0.015, 0.010, 0.008), rough=0.65)
sclera_mat = make_simple_mat("Sclera", (0.85, 0.82, 0.80), rough=0.25)
iris_mat = make_simple_mat("Iris", (0.055, 0.028, 0.014), rough=0.2)
pupil_mat = make_simple_mat("Pupil", (0.004, 0.004, 0.004), rough=0.15)
mouthline_mat = make_simple_mat("MouthLine", (0.10, 0.04, 0.03), rough=0.6)
glint_mat = make_simple_mat("Glint", (0.95, 0.95, 0.95), rough=0.05)

# ----------------------------------------------------------------------------
# Head volume: ellipsoid soup -> voxel remesh -> smooth
# ----------------------------------------------------------------------------
BLOBS = [
    # (center, semi-axes)
    ((0, 0.10, 0.32), (0.76, 0.74, 0.60)),     # cranium
    ((0, -0.18, 0.40), (0.62, 0.50, 0.52)),    # forehead
    ((0, -0.12, -0.10), (0.66, 0.52, 0.62)),   # midface / cheeks
    ((0, 0.00, -0.46), (0.52, 0.55, 0.48)),    # jaw
    ((0, -0.32, -0.66), (0.34, 0.34, 0.24)),   # chin
    ((0.44, -0.25, 0.00), (0.24, 0.28, 0.32)),   # cheekbone L
    ((-0.44, -0.25, 0.00), (0.24, 0.28, 0.32)),  # cheekbone R
    ((0.28, -0.36, -0.26), (0.11, 0.15, 0.14)),   # smile cheek L
    ((-0.28, -0.36, -0.26), (0.11, 0.15, 0.14)),  # smile cheek R
    ((0, -0.70, 0.10), (0.095, 0.14, 0.34)),   # nose bridge
    ((0, -0.78, -0.14), (0.14, 0.18, 0.15)),   # nose tip
    ((0.10, -0.73, -0.26), (0.075, 0.09, 0.075)),   # nostril L
    ((-0.10, -0.73, -0.26), (0.075, 0.09, 0.075)),  # nostril R
    ((0, -0.60, -0.42), (0.30, 0.13, 0.16)),   # mouth mass
    ((0, 0.10, -1.15), (0.38, 0.42, 0.55)),    # neck top blend
]

bm = bmesh.new()
for c, s in BLOBS:
    mat = Matrix.LocRotScale(Vector(c), None, Vector(s))
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=1.0,
                              matrix=mat)
# neck column
mat = Matrix.LocRotScale(Vector((0, 0.10, -1.30)), None, Vector((0.30, 0.38, 0.40)))
bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=1.0, radius2=1.0,
                      depth=1.0, matrix=mat)

head_mesh = bpy.data.meshes.new("Head")
bm.to_mesh(head_mesh)
bm.free()
head = bpy.data.objects.new("Head", head_mesh)
link_obj(head)
bpy.context.view_layer.objects.active = head
head.select_set(True)

rem = head.modifiers.new("Rem", "REMESH")
rem.mode = "VOXEL"
rem.voxel_size = 0.045
smo = head.modifiers.new("Smo", "SMOOTH")
smo.factor = 1.0
smo.iterations = 6
bpy.ops.object.modifier_apply(modifier="Rem")
bpy.ops.object.modifier_apply(modifier="Smo")
head.data.materials.append(skin_mat)
shade_smooth(head.data)

# clip everything below the neck bottom; reinforce the nose profile that
# laplacian smoothing shrank (push nose region forward along -Y)

def nose_push(x, z):
    return 0.05 * math.exp(-((x / 0.12) ** 2)) * math.exp(-(((z + 0.05) / 0.25) ** 2))

for v in head.data.vertices:
    if v.co.z < -1.45:
        v.co.z = -1.45
    x, y, z = v.co
    if y < -0.45:
        v.co.y -= nose_push(x, z)

# ----------------------------------------------------------------------------
# Vertex masks: stubble + lips
# ----------------------------------------------------------------------------
me = head.data
col_st = me.color_attributes.new(name="stubble", type="FLOAT_COLOR", domain="POINT")
col_lip = me.color_attributes.new(name="lipmask", type="FLOAT_COLOR", domain="POINT")


def stubble_weight(x, y, z):
    w = 0.0
    if z < -0.66 and y < -0.18 and abs(x) < 0.40:   # chin / goatee zone
        d = min(1.0, (-0.66 - z) / 0.25)
        front = min(1.0, max(0.0, (-y - 0.18) / 0.35))
        w = max(w, 0.55 * d * front)
    if -0.37 < z < -0.27 and y < -0.55 and abs(x) < 0.24:   # mustache
        w = max(w, 0.50)
    if abs(x) > 0.36 and -0.85 < z < -0.60 and y < -0.25:   # jawline sides
        w = max(w, 0.15)
    if z < -1.00:   # fade out down the neck
        w *= max(0.0, (z + 1.30) / 0.30)
    return w


def lip_weight(x, y, z):
    u = (x / 0.26) ** 2 + ((y + 0.67) / 0.12) ** 2 + ((z + 0.42) / 0.10) ** 2
    if u < 1.0:
        return min(1.0, 1.4 * (1.0 - u))
    return 0.0

for i, v in enumerate(me.vertices):
    w = stubble_weight(*v.co)
    col_st.data[i].color = (w, w, w, 1.0)
    w = lip_weight(*v.co)
    col_lip.data[i].color = (w, w, w, 1.0)

# ----------------------------------------------------------------------------
# Hair shell from scalp region
# ----------------------------------------------------------------------------

def hairline(theta):
    f = (1 - math.cos(theta)) / 2.0
    thr = 0.40 - 1.15 * f
    thr += -0.02 * math.sin(6 * theta + 0.7) * math.exp(-((theta / 0.9) ** 2))
    thr += -0.06 * math.exp(-(((theta - 0.35) / 0.50) ** 2))  # deep sweep, his left
    return max(thr, -0.60)   # keep the nape edge clean


def hair_offset(z):
    return 0.038 + 0.040 * max(0.0, min(1.0, z))

bm_src = bmesh.new()
bm_src.from_mesh(me)
bm_src.verts.ensure_lookup_table()

hair_bm = bmesh.new()
vmap = {}
EAR_L = Vector((0.62, 0.05, -0.12))
EAR_R = Vector((-0.62, 0.05, -0.12))
for f in bm_src.faces:
    c = f.calc_center_median()
    theta = math.atan2(c.x, -c.y)
    near_ear = min((c - EAR_L).length, (c - EAR_R).length) < 0.19 and c.z < 0.02
    if c.z > hairline(theta) and not near_ear:
        nv = []
        for v in f.verts:
            if v.index not in vmap:
                co = v.co + v.normal * hair_offset(v.co.z)
                vmap[v.index] = hair_bm.verts.new(co)
            nv.append(vmap[v.index])
        try:
            hair_bm.faces.new(nv)
        except ValueError:
            pass

hair_mesh = bpy.data.meshes.new("Hair")
hair_bm.to_mesh(hair_mesh)
hair_bm.free()
bm_src.free()
hair = bpy.data.objects.new("Hair", hair_mesh)
hair.data.materials.append(hair_mat)
link_obj(hair)
shade_smooth(hair_mesh)

hsm = hair.modifiers.new("EdgeSmooth", "SMOOTH")
hsm.factor = 0.9
hsm.iterations = 8
sol = hair.modifiers.new("Solid", "SOLIDIFY")
sol.thickness = 0.09
sol.offset = -1.0
htex = bpy.data.textures.new("HairNoise", type="CLOUDS")
htex.noise_scale = 0.35
disp = hair.modifiers.new("Rough", "DISPLACE")
disp.texture = htex
disp.strength = 0.02
disp.mid_level = 0.5

# ----------------------------------------------------------------------------
# Ears (mostly hidden by hair)
# ----------------------------------------------------------------------------
for sx in (1, -1):
    add_sphere(f"Ear.{'L' if sx > 0 else 'R'}", skin_mat,
               (sx * 0.62, 0.05, -0.12), (0.06, 0.13, 0.18),
               rot=(0, math.radians(sx * 8), 0))

# ----------------------------------------------------------------------------
# Eyes: embedded eyeball + iris + pupil + almond lid rim
# ----------------------------------------------------------------------------
EYE_X, EYE_Y, EYE_Z, EYE_R = 0.29, -0.50, 0.10, 0.105

for sx in (1, -1):
    tag = "L" if sx > 0 else "R"
    center = Vector((sx * EYE_X, EYE_Y, EYE_Z))
    add_sphere(f"Eyeball.{tag}", sclera_mat, center, (EYE_R, EYE_R, EYE_R))
    add_sphere(f"Iris.{tag}", iris_mat,
               (sx * EYE_X, EYE_Y - EYE_R * 0.93, EYE_Z - 0.028),
               (0.056, 0.020, 0.056))
    add_sphere(f"Pupil.{tag}", pupil_mat,
               (sx * EYE_X, EYE_Y - EYE_R * 1.02, EYE_Z - 0.028),
               (0.022, 0.010, 0.022))
    add_sphere(f"Glint.{tag}", glint_mat,
               (sx * EYE_X - 0.018, EYE_Y - EYE_R * 1.03, EYE_Z + 0.005),
               (0.009, 0.005, 0.009))
    # eyelids: skin volumes covering the ball, leaving an almond opening
    add_sphere(f"LidUp.{tag}", skin_mat,
               (sx * EYE_X, EYE_Y + 0.010, EYE_Z + 0.088),
               (0.118, 0.100, 0.070))
    add_sphere(f"LidLow.{tag}", skin_mat,
               (sx * EYE_X, EYE_Y + 0.010, EYE_Z - 0.098),
               (0.118, 0.098, 0.065))
    # dark upper lash line hugging the eyeball, along the upper lid edge
    pts = []
    N = 24
    Rr = EYE_R + 0.003
    for i in range(N + 1):
        x = -0.092 + 0.184 * i / N
        dz = 0.018 - 0.014 * (x / 0.092) ** 2
        y = -math.sqrt(max(1e-6, Rr * Rr - x * x - dz * dz))
        pts.append(center + Vector((x, y, dz)))
    make_tube(f"Lash.{tag}", brow_mat, pts, 0.005, closed=False)

# ----------------------------------------------------------------------------
# Eyebrows: tubes following the forehead surface
# ----------------------------------------------------------------------------
FH_C = Vector((0, -0.18, 0.40))   # forehead blob center / semi-axes
FH_A = (0.62, 0.50, 0.52)


def forehead_y(x, z):
    q = 1 - (x / FH_A[0]) ** 2 - ((z - FH_C.z) / FH_A[2]) ** 2
    return FH_C.y - FH_A[1] * math.sqrt(max(0.0, q))

for sx in (1, -1):
    tag = "L" if sx > 0 else "R"
    pts = []
    N = 16
    for i in range(N + 1):
        t = i / N                       # 0 = inner end, 1 = outer end
        x = sx * (0.14 + 0.30 * t)
        z = 0.245 + 0.025 * math.sin(math.pi * min(t * 1.25, 1.0))
        y = forehead_y(x, z) - 0.012
        pts.append(Vector((x, y, z)))
    make_tube(f"Brow.{tag}", brow_mat, pts, 0.032, closed=False)

# ----------------------------------------------------------------------------
# Mouth line (slight smile) drawn on the mouth mass surface
# ----------------------------------------------------------------------------
MOUTH = Vector((0, -0.60, -0.45))
MA, MB, MC = 0.30, 0.13, 0.16  # mouth mass semi-axes
pts = []
N = 24
for i in range(N + 1):
    x = -0.215 + 0.43 * i / N
    z = -0.425 + 0.045 * (abs(x) / 0.215) ** 1.6   # corners curl up = smile
    q = 1 - (x / MA) ** 2 - ((z - MOUTH.z) / MC) ** 2
    y = MOUTH.y - MB * math.sqrt(max(0.0, q)) - 0.004
    y += 0.030 * (abs(x) / 0.215) ** 4             # tuck corners into the face
    y -= nose_push(x, z)   # follow the forward push applied to the head mesh
    pts.append(Vector((x, y, z)))
make_tube("MouthLine", mouthline_mat, pts, 0.008, closed=False)

# ----------------------------------------------------------------------------
# World, lights, camera
# ----------------------------------------------------------------------------
world = bpy.data.worlds.new("World")
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (0.85, 0.87, 0.90, 1.0)
bg.inputs[1].default_value = 0.35
scene.world = world

target = bpy.data.objects.new("Target", None)
target.location = (0, 0, -0.05)
link_obj(target)


def add_light(name, kind, loc, energy, size=1.0):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    if kind == "AREA":
        ld.size = size
    lo = bpy.data.objects.new(name, ld)
    lo.location = loc
    link_obj(lo)
    tc = lo.constraints.new("TRACK_TO")
    tc.target = target
    tc.track_axis = "TRACK_NEGATIVE_Z"
    tc.up_axis = "UP_Y"
    return lo

add_light("Key", "AREA", (-2.4, -3.6, 2.0), 260, size=3.0)
add_light("Fill", "AREA", (2.8, -3.0, 0.3), 110, size=3.0)
add_light("Rim", "AREA", (0.6, 3.6, 2.2), 200, size=2.0)

cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 85
cam = bpy.data.objects.new("Cam", cam_data)
link_obj(cam)
scene.camera = cam
tc = cam.constraints.new("TRACK_TO")
tc.target = target
tc.track_axis = "TRACK_NEGATIVE_Z"
tc.up_axis = "UP_Y"

scene.render.engine = "CYCLES"
scene.cycles.samples = 128
try:
    scene.cycles.use_denoising = True
except Exception:
    pass
scene.render.resolution_x = 900
scene.render.resolution_y = 1125
scene.render.image_settings.file_format = "PNG"

VIEWS = {
    "front": (0, -5.8, 0.05),
    "three_quarter": (-3.5, -4.6, 0.25),
    "side": (-5.8, -0.2, 0.1),
}
for vname, loc in VIEWS.items():
    cam.location = loc
    scene.render.filepath = os.path.join(RENDER_DIR, f"{vname}.png")
    bpy.ops.render.render(write_still=True)

bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
try:
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(HERE, "head.glb"),
        export_format="GLB",
        export_apply=True,
        use_selection=False,
    )
    print("GLB exported")
except Exception as exc:
    print("GLB export failed:", exc)
print("DONE build_head")
