import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import Stats from 'three/addons/libs/stats.module.js'
//import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import {
  MeshBVH,
  MeshBVHUniformStruct,
  shaderStructs,
  shaderIntersectFunction,
  SAH
} from 'three-mesh-bvh';

//
//  code sample
//
// https://github.com/N8python/three-mesh-bvh/blob/f1385758ccdb45993a7a0924a07904e7489d822a/example/diamond.js
//


// Texture
const textureLoader = new THREE.TextureLoader();
const environment = textureLoader.load('images/waterB.png');
environment.format = THREE.RGBAFormat;
environment.mapping = THREE.EquirectangularReflectionMapping;
environment.generateMipmaps = true;
environment.minFilter = THREE.LinearMipmapLinearFilter;
environment.magFilter = THREE.LinearFilter;

// Scene
const scene = new THREE.Scene()
//scene.background = environment;

// Camera
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.set(2.0, 3.0, 2.0);

//Render
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
 });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2.0))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.outputColorSpace  = THREE.SRGBColorSpace; //THREE.SRGBColorSpace default THREE.LinearSRGBColorSpace
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild( renderer.domElement );


// orbitcontol
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.2;
controls.enableRotate = true;
controls.target.set(0.0, 0.0, 0.0);
controls.enabled = true;

// statu
const stats = new Stats()
document.body.appendChild(stats.dom)


// helper
// const AxesHelper = new THREE.AxesHelper(0.5)
// scene.add(AxesHelper)
const GridHelper = new THREE.GridHelper( 5, 5, 0xcccccc, 0xcccccc )
scene.add(GridHelper)


// Material
const diamondMaterial = new THREE.ShaderMaterial({
  uniforms: {
    envMap: { value: environment },
    bvh: { value: new MeshBVHUniformStruct() },
    projectionMatrixInv: { value: camera.projectionMatrixInverse },
    viewMatrixInv: { value: camera.matrixWorld },
    resolution: { value:new THREE.Vector2(window.innerWidth, window.innerHeight)  },
    // internal reflection settings
    bounces: { value: 3 },
    ior: { value: 2.4 },
    // chroma and color settings
    color: { value: new THREE.Color( 0xFFFFFF ) },
    fastChroma: { value: false },
    aberrationStrength: { value: 0.01 },
},
vertexShader:`
			varying vec3 vWorldPosition;
			varying vec3 vNormal;
			uniform mat4 viewMatrixInv;
			void main() {

				vWorldPosition = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
				vNormal = ( viewMatrixInv * vec4( normalMatrix * normal, 0.0 ) ).xyz;
				gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4( position , 1.0 );

			}
`,
fragmentShader: `
			#define RAY_OFFSET 0.001

			#include <common>
			precision highp isampler2D;
			precision highp usampler2D;

			${ shaderStructs }
			${ shaderIntersectFunction }

			varying vec3 vWorldPosition;
			varying vec3 vNormal;

			uniform sampler2D envMap;
			uniform float bounces;
			uniform BVH bvh;
			uniform float ior;
			uniform vec3 color;
			uniform bool fastChroma;
			uniform mat4 projectionMatrixInv;
			uniform mat4 viewMatrixInv;
			uniform mat4 modelMatrix;
			uniform vec2 resolution;
			uniform float aberrationStrength;

			#include <cube_uv_reflection_fragment>

			// performs an iterative bounce lookup modeling internal reflection and returns
			// a final ray direction.
			vec3 totalInternalReflection( vec3 incomingOrigin, vec3 incomingDirection, vec3 normal, float ior, mat4 modelMatrixInverse ) {

				vec3 rayOrigin = incomingOrigin;
				vec3 rayDirection = incomingDirection;

				// refract the ray direction on the way into the diamond and adjust offset from
				// the diamond surface for raytracing
				rayDirection = refract( rayDirection, normal, 1.0 / ior );
				rayOrigin = vWorldPosition + rayDirection * RAY_OFFSET;

				// transform the ray into the local coordinates of the model
				rayOrigin = ( modelMatrixInverse * vec4( rayOrigin, 1.0 ) ).xyz;
				rayDirection = normalize( ( modelMatrixInverse * vec4( rayDirection, 0.0 ) ).xyz );

				// perform multiple ray casts
				for( float i = 0.0; i < bounces; i ++ ) {

					// results
					uvec4 faceIndices = uvec4( 0u );
					vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
					vec3 barycoord = vec3( 0.0 );
					float side = 1.0;
					float dist = 0.0;

					// perform the raycast
					// the diamond is a water tight model so we assume we always hit a surface
					bvhIntersectFirstHit( bvh, rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist );

					// derive the new ray origin from the hit results
					vec3 hitPos = rayOrigin + rayDirection * dist;

					// if we don't internally reflect then end the ray tracing and sample
					vec3 refractedDirection = refract( rayDirection, faceNormal, ior );
					bool totalInternalReflection = length( refract( rayDirection, faceNormal, ior ) ) == 0.0;
					if ( ! totalInternalReflection ) {

						rayDirection = refractedDirection;
						break;

					}

					// otherwise reflect off the surface internally for another hit
					rayDirection = reflect( rayDirection, faceNormal );
					rayOrigin = hitPos + rayDirection * RAY_OFFSET;

				}

				// return the final ray direction in world space
				return normalize( ( modelMatrix * vec4( rayDirection, 0.0 ) ).xyz );
			}

			vec4 envSample( sampler2D envMap, vec3 rayDirection ) {

				vec2 uvv = equirectUv( rayDirection );
				return texture( envMap, uvv );

			}

			void main() {

				mat4 modelMatrixInverse = inverse( modelMatrix );
				vec2 uv = gl_FragCoord.xy / resolution;

				vec3 normal = vNormal;
				vec3 rayOrigin = cameraPosition;
				vec3 rayDirection = normalize( vWorldPosition - cameraPosition );

				if ( aberrationStrength != 0.0 ) {

					// perform chromatic aberration lookups
					vec3 rayDirectionG = totalInternalReflection( rayOrigin, rayDirection, normal, max( ior, 1.0 ), modelMatrixInverse );
					vec3 rayDirectionR, rayDirectionB;

					if ( fastChroma ) {

						// fast chroma does a quick uv offset on lookup
						rayDirectionR = normalize( rayDirectionG + 1.0 * vec3( aberrationStrength / 2.0 ) );
						rayDirectionB = normalize( rayDirectionG - 1.0 * vec3( aberrationStrength / 2.0 ) );

					} else {

						// compared to a proper ray trace of diffracted rays
						float iorR = max( ior * ( 1.0 - aberrationStrength ), 1.0 );
						float iorB = max( ior * ( 1.0 + aberrationStrength ), 1.0 );
						rayDirectionR = totalInternalReflection(
							rayOrigin, rayDirection, normal,
							iorR, modelMatrixInverse
						);
						rayDirectionB = totalInternalReflection(
							rayOrigin, rayDirection, normal,
							iorB, modelMatrixInverse
						);

					}

					// get the color lookup
					float r = envSample( envMap, rayDirectionR ).r;
					float g = envSample( envMap, rayDirectionG ).g;
					float b = envSample( envMap, rayDirectionB ).b;
					gl_FragColor.rgb = vec3( r, g, b ) * color;
					gl_FragColor.a = 1.0;

				} else {

					// no chromatic aberration lookups
					rayDirection = totalInternalReflection( rayOrigin, rayDirection, normal, max( ior, 1.0 ), modelMatrixInverse );
					gl_FragColor.rgb = envSample( envMap, rayDirection ).rgb * color;
					gl_FragColor.a = 1.0;

				}

				#include <tonemapping_fragment>

			}
  `,
//return mesh.material.uniforms.bvh.value.updateFrom(newBVH),

})


/////////////////////////////////////////////////////////////////////////
//// DRACO LOADER TO LOAD DRACO COMPRESSED MODELS FROM BLENDER
const dracoLoader = new DRACOLoader()
const loader = new GLTFLoader()
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')
dracoLoader.setDecoderConfig({ type: 'js' })
loader.setDRACOLoader(dracoLoader)

let diamond;

loader.load('./model/daimondo.glb', // Replace with your actual path
    function (loadedObject) {

      console.log(loadedObject.scene);
      // @ts-ignore
      const diamondGeo = loadedObject.scene.children[0].geometry;

      const bvh = new MeshBVH( diamondGeo, { strategy: SAH, maxLeafTris: 1 } );
      diamondMaterial.uniforms.bvh.value.updateFrom( bvh );
      diamond = new THREE.Mesh( diamondGeo, diamondMaterial );

      scene.add( diamond );
    },
    function (xhr) {
        console.log((xhr.loaded / xhr.total * 100) + '% loaded');
    },
    function (error) {
        console.error('An error happened', error);
    }
);



function RenderLoop() {

  //orbitcontoll
  controls.update()

  renderer.render(scene, camera)

  stats.update()
  requestAnimationFrame(RenderLoop)
}

RenderLoop()



// ウィンドウのリサイズ時にrendererとカメラのアスペクト比を更新
window.addEventListener('resize', () => {
  const pixel = Math.min(window.devicePixelRatio, 2.0);
  //
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  //
  renderer.setPixelRatio(pixel) //set pixel ratio
  renderer.setSize(window.innerWidth, window.innerHeight);

  diamondMaterial.uniforms.resolution.value = new THREE.Vector2(window.innerWidth, window.innerHeight);
})